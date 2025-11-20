import { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Phone, SkipForward, User, Radio, Loader2, PhoneOff } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged,
  signInWithCustomToken // 保持，以防未来扩展
} from 'firebase/auth';
import type { User as FirebaseUser } from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  doc, 
  onSnapshot, 
  deleteDoc, 
  getDocs, 
  query, 
  where, 
  limit, 
  addDoc,
  updateDoc,
  serverTimestamp,
  runTransaction,
} from 'firebase/firestore';

// --- Global Variable Declarations (Mandatory for Canvas) ---
// 声明环境全局变量，用于获取配置和认证信息
declare const __app_id: string;
declare const __firebase_config: string;
declare const __initial_auth_token: string;

// --- Firebase Configuration & Initialization ---

// 硬编码配置作为可靠的回退。
// NOTE: 请将这些占位符替换为您自己的 Firebase 项目凭证。

const hardcodedConfig = {
  apiKey: "AIzaSyB4D35IX8vGMyeAcWTlZgyp5guHjJM0J_Y",
  authDomain: "audiochat-db1f4.firebaseapp.com",
  projectId: "audiochat-db1f4",
  storageBucket: "audiochat-db1f4.firebasestorage.app",
  messagingSenderId: "437257644304",
  appId: "1:437257644304:web:90adf746bc27d9e5831d95",
  measurementId: "G-1E27PDDW52"
};

const firebaseConfig: any = (() => {
  // 1. 检查 Canvas 全局配置 (优先级最高)
  if (typeof __firebase_config !== 'undefined') {
    try {
      const config = JSON.parse(__firebase_config);
      if (config && config.projectId) {
         return config; // 优先使用 Canvas 注入的配置
      }
    } catch (e) {
      console.error("Failed to parse __firebase_config. Using hardcoded fallback.", e);
    }
  }
  
  // 2. 使用硬编码作为最终回退 (已移除环境变量检查)
  return hardcodedConfig;
})();

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// 优先使用 Canvas App ID，否则使用 Firebase 配置中的 projectId 或默认值
const appId = typeof __app_id !== 'undefined' ? __app_id : firebaseConfig.projectId || 'default-app-id'; 

// WebRTC Configuration (Public STUN servers)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// --- Types & Constants ---
type ConnectionStatus = 'idle' | 'searching' | 'connecting' | 'connected' | 'error';

export default function App() {
  // --- State ---
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [micEnabled, setMicEnabled] = useState(true);
  const [debugMsg, setDebugMsg] = useState('');
  const [callDuration, setCallDuration] = useState(0);
  
  // --- Refs ---
  const localStreamRef = useRef<MediaStream | null>(null);
  // 修复：初始化值应为 null，而不是引用自身
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const currentCallDocIdRef = useRef<string | null>(null); 
  const queueDocIdRef = useRef<string | null>(null);
  const unsubscribeCallRef = useRef<(() => void) | null>(null);

  // --- Initialization ---
  useEffect(() => {
    const initAuth = async () => {
      const auth = getAuth(app);
      try {
        if (typeof __initial_auth_token !== 'undefined') {
          // Use custom token if provided (Canvas environment)
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          // Fallback to anonymous sign-in
          await signInAnonymously(auth);
        }
      } catch (e) {
        console.error("Auth failed", e);
        setDebugMsg("认证失败，请刷新重试");
      }
    };
    initAuth();

    const unsubscribe = onAuthStateChanged(getAuth(app), (u) => {
      setUser(u);
    });

    // Cleanup on unmount
    return () => {
      hangUp();
      unsubscribe();
    };
  }, []);

  // Timer for call duration
  useEffect(() => {
    let interval: any;
    if (status === 'connected') {
      interval = setInterval(() => {
        setCallDuration(prev => prev + 1);
      }, 1000);
    } else {
      setCallDuration(0);
    }
    return () => clearInterval(interval);
  }, [status]);

  // --- Helper: Get User Media ---
  const getLocalStream = async () => {
    if (localStreamRef.current) return localStreamRef.current;
    try {
      // 必须在 HTTPS 环境下才能获取麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      return stream;
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setDebugMsg("无法访问麦克风，请检查权限");
      throw err;
    }
  };

  // --- Helper: Format Time ---
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // --- Core Logic: Search & Match ---
  const startMatching = async () => {
    if (!user) {
        setDebugMsg('认证中，请稍候...');
        return;
    }
    
    // Reset state
    await hangUp(); 
    setStatus('searching');
    setDebugMsg('正在寻找路人...');

    try {
      await getLocalStream(); // Ensure we have mic ready

      // 1. Check if anyone is waiting in the queue
      const queueRef = collection(db, 'artifacts', appId, 'public', 'data', 'voice_queue');
      // Only find people who are NOT me
      const q = query(queueRef, where('userId', '!=', user.uid), limit(1));
      
      // Use a transaction to atomicaly "grab" a waiting user
      await runTransaction(db, async (transaction) => {
        const querySnapshot = await getDocs(q);
        
        if (!querySnapshot.empty) {
          // --- Found a match! (I am the Caller) ---
          const targetDoc = querySnapshot.docs[0];
          const targetUserId = targetDoc.data().userId;
          
          // Delete them from queue so no one else grabs them
          transaction.delete(targetDoc.ref);
          
          setDebugMsg('找到伙伴！正在连接...');
          
          // Create a Call Room
          const callDocRef = doc(collection(db, 'artifacts', appId, 'public', 'data', 'voice_calls'));
          currentCallDocIdRef.current = callDocRef.id;

          // Set up initial call data
          transaction.set(callDocRef, {
            callerId: user.uid,
            calleeId: targetUserId,
            created: serverTimestamp(),
            offer: null,
            answer: null
          });

          // Initialize WebRTC as Caller (outside transaction strictly speaking, but needed logic flow)
          // We will trigger the actual createOffer in the logic below checking 'currentCallDocIdRef'
          return { role: 'caller', callId: callDocRef.id };
        } else {
          // --- No one waiting (I am the Waiter) ---
          return { role: 'waiter' };
        }
      }).then(async (result: any) => {
        if (result.role === 'caller') {
          setStatus('connecting');
          await initializePeerConnection(result.callId, 'caller');
        } else {
          // Add myself to queue
          const queueRef = collection(db, 'artifacts', appId, 'public', 'data', 'voice_queue');
          const myQueueDoc = await addDoc(queueRef, {
            userId: user.uid,
            created: serverTimestamp()
          });
          queueDocIdRef.current = myQueueDoc.id;
          
          // Listen for someone to pick me up
          listenForIncomingCalls();
        }
      });

    } catch (err) {
      console.error(err);
      setDebugMsg("匹配出错，请重试");
      setStatus('error');
    }
  };

  // --- Logic: Listen for Incoming Calls (Waiter Side) ---
  const listenForIncomingCalls = () => {
    if (!user) return;
    const callsRef = collection(db, 'artifacts', appId, 'public', 'data', 'voice_calls');
    const q = query(callsRef, where('calleeId', '==', user.uid), limit(1));

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          // Someone called me!
          const callId = change.doc.id;
          
          // Clean up my queue entry if it exists (optional, but good hygiene)
          if (queueDocIdRef.current) {
             deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'voice_queue', queueDocIdRef.current)).catch(() => {});
             queueDocIdRef.current = null;
          }

          setDebugMsg('连接中...');
          currentCallDocIdRef.current = callId;
          setStatus('connecting');
          
          // Unsubscribe from listening to new calls
          if (unsubscribeCallRef.current) {
             unsubscribeCallRef.current();
          }
          
          // Initialize WebRTC as Callee
          await initializePeerConnection(callId, 'callee');
        }
      });
    });
    
    unsubscribeCallRef.current = unsubscribe;
  };

  // --- WebRTC: Initialize Connection ---
  const initializePeerConnection = async (callId: string, role: 'caller' | 'callee') => {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnectionRef.current = pc;

    // Add local tracks
    const stream = await getLocalStream();
    stream.getTracks().forEach(track => {
      pc.addTrack(track, stream);
    });

    // Handle remote tracks
    pc.ontrack = (event) => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = event.streams[0];
        setStatus('connected');
        setDebugMsg('');
      }
    };

    // ICE Candidates Logic
    const callDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'voice_calls', callId);
    const candidatesCollection = collection(callDocRef, role === 'caller' ? 'calleeCandidates' : 'callerCandidates');
    const myCandidatesCollection = collection(callDocRef, role === 'caller' ? 'callerCandidates' : 'calleeCandidates');

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        addDoc(myCandidatesCollection, event.candidate.toJSON());
      }
    };

    // Signaling Logic
    if (role === 'caller') {
      // Create Offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await updateDoc(callDocRef, { offer: { type: offer.type, sdp: offer.sdp } });
      
      // Listen for Answer
      const unsub = onSnapshot(callDocRef, (snapshot) => {
        const data = snapshot.data();
        if (!pc.currentRemoteDescription && data?.answer) {
          const answerDescription = new RTCSessionDescription(data.answer);
          pc.setRemoteDescription(answerDescription);
        }
      });
      unsubscribeCallRef.current = unsub; // Overwrite the previous queue listener if any

    } else {
      // Listen for Offer (It should be there or coming very soon)
      const unsub = onSnapshot(callDocRef, async (snapshot) => {
         const data = snapshot.data();
         if (!pc.currentRemoteDescription && data?.offer) {
            const offerDescription = new RTCSessionDescription(data.offer);
            await pc.setRemoteDescription(offerDescription);
            
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            await updateDoc(callDocRef, { answer: { type: answer.type, sdp: answer.sdp } });
         }
      });
      unsubscribeCallRef.current = unsub;
    }

    // Listen for Remote ICE Candidates
    onSnapshot(candidatesCollection, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          pc.addIceCandidate(candidate);
        }
      });
    });
  };

  // --- Actions: Hang Up / Next ---
  const hangUp = async () => {
    // 1. Stop WebRTC
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    // 2. Stop Local Stream (optional: keep it if we want fast switching, but cleaner to stop)
    // Keeping it alive for faster "Next" switching, only stop on component unmount
    
    // 3. Unsubscribe Firestore listeners
    if (unsubscribeCallRef.current) {
      unsubscribeCallRef.current();
      unsubscribeCallRef.current = null;
    }

    // 4. Clean up Firestore
    if (queueDocIdRef.current) {
       deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'voice_queue', queueDocIdRef.current)).catch(e => console.log(e));
       queueDocIdRef.current = null;
    }
    // We don't strictly delete the Call doc immediately to avoid race conditions on the other user's end reading it,
    // but in a production app we would have a cleanup trigger or TTL.
    
    setStatus('idle');
    setDebugMsg('');
    setCallDuration(0);
    currentCallDocIdRef.current = null;
  };

  const handleNext = async () => {
    await hangUp();
    setTimeout(() => {
        startMatching();
    }, 300); // Brief delay to reset UI visually
  };

  const toggleMic = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !micEnabled;
      });
      setMicEnabled(!micEnabled);
    }
  };

  // --- UI Render ---
  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-between overflow-hidden font-sans">
      {/* Hidden Audio Element */}
      <audio ref={remoteAudioRef} autoPlay playsInline />

      {/* Header */}
      <header className="w-full p-4 flex justify-between items-center bg-gray-800/50 backdrop-blur-md border-b border-gray-700 absolute top-0 z-10">
        <div className="flex items-center gap-2">
          <Radio className={`w-5 h-5 ${status === 'connected' ? 'text-green-400 animate-pulse' : 'text-gray-400'}`} />
          <h1 className="text-lg font-bold tracking-wide">AnonymousVoice</h1>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400 bg-gray-800 px-3 py-1 rounded-full">
          <User className="w-3 h-3" />
          {user ? user.uid : '认证中...'}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 w-full flex flex-col items-center justify-center relative px-4">
        
        {/* Status Indicator / Visualizer */}
        <div className="relative w-64 h-64 flex items-center justify-center mb-8">
          
          {/* Ripple Effects (CSS based) */}
          {status === 'searching' && (
            <>
               <div className="absolute w-full h-full rounded-full border-4 border-blue-500/30 animate-[ping_2s_ease-in-out_infinite]"></div>
               <div className="absolute w-48 h-48 rounded-full border-4 border-blue-500/50 animate-[ping_2s_ease-in-out_infinite_0.5s]"></div>
            </>
          )}
          
          {status === 'connected' && (
            <>
              <div className="absolute w-64 h-64 bg-green-500/10 rounded-full blur-xl animate-pulse"></div>
              <div className="absolute w-56 h-56 rounded-full border border-green-500/20 animate-[spin_4s_linear_infinite]"></div>
            </>
          )}

          {/* Central Avatar/Icon */}
          <div className={`relative z-10 w-32 h-32 rounded-full flex items-center justify-center shadow-2xl transition-all duration-500 ${
            status === 'connected' ? 'bg-gradient-to-br from-green-400 to-emerald-600 scale-110' :
            status === 'searching' ? 'bg-gradient-to-br from-blue-500 to-indigo-600' :
            'bg-gray-700'
          }`}>
             {status === 'idle' && <Radio className="w-12 h-12 text-gray-400" />}
             {status === 'searching' && <Loader2 className="w-12 h-12 text-white animate-spin" />}
             {status === 'connecting' && <Loader2 className="w-12 h-12 text-white animate-spin" />}
             {status === 'connected' && <User className="w-12 h-12 text-white" />}
          </div>
        </div>

        {/* Text Status */}
        <div className="text-center space-y-2 z-10">
          {status === 'idle' && (
             <h2 className="text-2xl font-light text-gray-300">准备好了吗？</h2>
          )}
          
          {status === 'searching' && (
             <h2 className="text-2xl font-light text-blue-300 animate-pulse">正在寻找随机路人...</h2>
          )}
          
          {status === 'connecting' && (
             <h2 className="text-2xl font-light text-yellow-300">建立加密连接中...</h2>
          )}
          
          {status === 'connected' && (
            <>
              <h2 className="text-3xl font-bold text-white tracking-widest font-mono">{formatTime(callDuration)}</h2>
              <p className="text-green-400 text-sm">语音通道已建立</p>
            </>
          )}
          
          {status === 'error' && (
            <p className="text-red-400">{debugMsg || "发生错误"}</p>
          )}
          
          {/* Debug message for loading states */}
          {status !== 'connected' && status !== 'idle' && debugMsg && (
             <p className="text-gray-500 text-xs mt-2">{debugMsg}</p>
          )}
        </div>
      </main>

      {/* Controls Footer */}
      <footer className="w-full p-8 pb-12 bg-gray-800/30 backdrop-blur-sm rounded-t-3xl border-t border-white/5">
        <div className="flex items-center justify-center gap-6 max-w-md mx-auto">
          
          {/* Left: Mute Toggle (Only active when connected or searching) */}
          <button 
            onClick={toggleMic}
            disabled={status === 'idle'}
            className={`p-4 rounded-full transition-all duration-200 ${
              status === 'idle' ? 'bg-gray-800 text-gray-600 cursor-not-allowed' :
              !micEnabled ? 'bg-red-500/20 text-red-500 hover:bg-red-500/30' : 'bg-gray-700 text-white hover:bg-gray-600'
            }`}
          >
            {micEnabled ? <Mic className="w-6 h-6" /> : <MicOff className="w-6 h-6" />}
          </button>

          {/* Center: Main Action Button */}
          {status === 'idle' ? (
            <button 
              onClick={startMatching}
              disabled={!user} // Disable if user is null (still authenticating)
              className={`flex-1 font-bold py-4 px-8 rounded-full shadow-lg shadow-white/10 transition-all flex items-center justify-center gap-2 ${!user ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-white text-black hover:scale-105 active:scale-95'}`}
            >
              <Phone className="w-5 h-5" />
              <span>开始匹配</span>
            </button>
          ) : (
            <button 
              onClick={handleNext}
              className="flex-1 bg-gradient-to-r from-purple-500 to-pink-500 text-white font-bold py-4 px-8 rounded-full shadow-lg hover:shadow-pink-500/20 hover:scale-105 active:scale-95 transition-all flex items-center justify-center gap-2"
            >
              <SkipForward className="w-6 h-6 fill-current" />
              <span>{status === 'connected' ? '换一个' : '跳过'}</span>
            </button>
          )}

          {/* Right: Hangup (Only visible when not idle) */}
          <button 
             onClick={hangUp}
             disabled={status === 'idle'}
             className={`p-4 rounded-full transition-all duration-200 ${
               status === 'idle' ? 'bg-gray-800 text-gray-600 opacity-0' : 'bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-900/20'
             }`}
          >
            <PhoneOff className="w-6 h-6" />
          </button>

        </div>
        <p className="text-center text-gray-600 text-xs mt-6">
           匿名 • 随机 • 阅后即焚
        </p>
      </footer>
    </div>
  );
}