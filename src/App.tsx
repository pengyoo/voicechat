import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Phone, SkipForward, User, Radio, Loader2, PhoneOff } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged,
  signInWithCustomToken 
} from 'firebase/auth';
import type { User as FirebaseUser } from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  doc, 
  onSnapshot, 
  deleteDoc, 
  getDocs, // <-- 引入 getDocs 用于外部查询
  query, 
  where, 
  limit, 
  addDoc,
  updateDoc,
  serverTimestamp,
  runTransaction,
  Timestamp, // 引入 Timestamp
} from 'firebase/firestore';

// --- Global Variable Declarations (Mandatory for Canvas) ---
declare const __app_id: string;
declare const __firebase_config: string;
declare const __initial_auth_token: string;

// --- Constants ---
const HEARTBEAT_INTERVAL = 10000; // 10秒发送一次心跳
const GHOST_CUTOFF_SECONDS = 15; // 超过15秒未活跃的用户视为幽灵用户

// --- Firebase Configuration & Initialization ---
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
  if (typeof __firebase_config !== 'undefined') {
    try {
      const config = JSON.parse(__firebase_config);
      if (config && config.projectId) {
         return config;
      }
    } catch (e) {
      console.error("Failed to parse __firebase_config. Using hardcoded fallback.", e);
    }
  }
  return hardcodedConfig;
})();

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
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
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const currentCallDocIdRef = useRef<string | null>(null); 
  const queueDocIdRef = useRef<string | null>(null);
  const unsubscribeCallRef = useRef<(() => void) | null>(null);

  // --- Helper: Get User Media ---
  const getLocalStream = async () => {
    // 每次匹配都尝试获取新的流，以确保不重用已停止的轨道
    if (localStreamRef.current) {
        // 如果流存在，先停止旧流的轨道
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
    }
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      localStreamRef.current = stream;
      // 保证新流的初始启用状态与 UI 匹配
      stream.getAudioTracks().forEach(track => {
         track.enabled = micEnabled;
      });
      return stream;
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setDebugMsg("无法访问麦克风，请检查权限");
      throw err;
    }
  };

  // --- Actions: Hang Up / Next ---
  const hangUp = useCallback(async () => {
    // 1. Stop WebRTC
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    // 2. STOP and clear Local Stream Tracks (CRITICAL FIX)
    if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => {
            track.stop(); // 停止轨道
        });
        localStreamRef.current = null; // 清空引用，确保下次匹配时获取新流
    }
    setMicEnabled(true); // 重置麦克风启用状态

    // 3. Unsubscribe Firestore listeners
    if (unsubscribeCallRef.current) {
      unsubscribeCallRef.current();
      unsubscribeCallRef.current = null;
    }

    // 4. Clean up Firestore Queue entry
    if (queueDocIdRef.current) {
       // 清理自己排队的条目
       deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'voice_queue', queueDocIdRef.current)).catch(e => console.log("Failed to delete queue doc:", e));
       queueDocIdRef.current = null;
    }
    
    // --- FIX: Clean up active Call Room document for explicit signal ---
    if (currentCallDocIdRef.current) {
       // 清理当前通话房间，这会立即触发对方的 onSnapshot，更快地通知对方挂断
       const callDocRef = doc(db, 'artifacts', appId, 'public', 'data', 'voice_calls', currentCallDocIdRef.current);
       deleteDoc(callDocRef).catch(e => console.log("Failed to delete call doc:", e));
    }
    // ----------------------------------------------------

    setStatus('idle');
    setDebugMsg('');
    setCallDuration(0);
    currentCallDocIdRef.current = null;
  }, [appId]); // Added appId to dependencies for safety

  // --- Initialization & Cleanup ---
  useEffect(() => {
    const initAuth = async () => {
      const auth = getAuth(app);
      try {
        if (typeof __initial_auth_token !== 'undefined') {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
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

    // Cleanup on unmount (App component unloads)
    return () => {
      hangUp();
      unsubscribe();
    };
  }, [hangUp]);

  // --- NEW: Handle Browser Close/Reload Cleanup ---
  useEffect(() => {
      const handleBeforeUnload = () => {
          // 在浏览器关闭或刷新前，尝试异步执行清理操作。
          // ⚠️ 注意：这个操作是尽力而为的，因为浏览器可能会在操作完成前关闭连接。
          hangUp();
      };

      window.addEventListener('beforeunload', handleBeforeUnload);

      return () => {
          window.removeEventListener('beforeunload', handleBeforeUnload);
      };
  }, [hangUp]);


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
  
  // --- Heartbeat Logic (Fix for Ghost Users) ---
  useEffect(() => {
      let heartbeatTimer: any;

      const sendHeartbeat = async () => {
          const docId = queueDocIdRef.current;
          if (docId && user) {
              try {
                  const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'voice_queue', docId);
                  await updateDoc(docRef, {
                      lastActive: serverTimestamp()
                  });
              } catch (e) {
                  // If update fails, it likely means the doc was deleted (e.g., by another user who matched us)
                  console.log("Heartbeat failed, potentially matched or deleted:", e);
                  // Since the doc is gone, we can stop the heartbeat
                  clearInterval(heartbeatTimer);
                  // But only clear ref if we are no longer searching (this is a simple fail-safe)
                  if (status !== 'searching') {
                      queueDocIdRef.current = null;
                  }
              }
          }
      };

      if (status === 'searching' && user && queueDocIdRef.current) {
          // Send initial heartbeat immediately
          sendHeartbeat();
          // Set up recurring heartbeat
          heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
      } else if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
      }

      return () => clearInterval(heartbeatTimer);
  }, [status, user, appId]);


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
    
    // Reset state and clear old stream
    await hangUp(); 
    
    setStatus('searching');
    setDebugMsg('正在寻找路人...');

    try {
      // Get a fresh stream every time
      await getLocalStream(); 

      // 1. Define cutoff time for active users (Ghost Filtering)
      const cutoffTime = Timestamp.fromMillis(Date.now() - GHOST_CUTOFF_SECONDS * 1000);

      // 2. Query only users who have sent a recent heartbeat (Active users)
      const queueRef = collection(db, 'artifacts', appId, 'public', 'data', 'voice_queue');
      // CRITICAL: We use a simple range query on 'lastActive' + limit, which should avoid composite index requirements.
      const q = query(queueRef, where('lastActive', '>', cutoffTime), limit(15));
      
      // *** STEP 1: FETCH CANDIDATES OUTSIDE TRANSACTION (NON-ATOMIC READ) ***
      const potentialCandidatesSnapshot = await getDocs(q);
      
      // Use a transaction to atomicaly "grab" a waiting user
      await runTransaction(db, async (transaction) => {
        
        // --- Client-side filtering and sorting for FIFO ---
        const availableDocs = potentialCandidatesSnapshot.docs
            .filter(doc => doc.data().userId !== user.uid) // Exclude current user
            // Sort by 'created' timestamp (oldest first) to ensure FIFO
            .sort((a, b) => {
                const aTime = a.data().created?.toMillis() || 0;
                const bTime = b.data().created?.toMillis() || 0;
                return aTime - bTime;
            });

        if (availableDocs.length > 0) {
          // --- Found a match! (I am the Caller) ---
          const targetDocRef = availableDocs[0].ref;
          
          // *** STEP 2: ATOMICALLY READ (INSIDE transaction) to check if it still exists ***
          const currentTargetDoc = await transaction.get(targetDocRef);
          
          if (!currentTargetDoc.exists()) {
              // Race condition lost: Another client deleted this document just before our transaction.
              console.log("Lost race condition. Document already deleted.");
              return { role: 'waiter' };
          }
          
          const targetUserId = currentTargetDoc.data()?.userId;
          if (!targetUserId) {
               // Malformed data
               return { role: 'waiter' };
          }
          
          // Delete them from queue so no one else grabs them
          transaction.delete(targetDocRef);
          
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
            created: serverTimestamp(),
            lastActive: serverTimestamp() // <-- Added initial heartbeat
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
    // This query is safe (simple equality filter)
    const q = query(callsRef, where('calleeId', '==', user.uid), limit(1));

    const unsubscribe = onSnapshot(q, async (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
          const callId = change.doc.id;
          
          // Clean up my queue entry if it exists
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
        
        // FIX: Detect when the CALLER deletes the document (explicit hangup)
        if (change.type === 'removed') {
             console.log(`Call document ${change.doc.id} removed by partner. Hanging up.`);
             setDebugMsg('伙伴已挂断，请尝试新的连接');
             // 延迟执行 hangUp 以确保当前操作栈完成
             setTimeout(() => {
                hangUp();
             }, 500);
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
    
    // WebRTC 连接状态监听，处理意外断开和失败
    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            if (currentCallDocIdRef.current) { 
                console.log(`WebRTC connection lost: ${pc.iceConnectionState}`);
                setDebugMsg('连接已断开，请重试或换一个');
                setTimeout(() => {
                    hangUp(); 
                }, 500);
            }
        }
    };
    // ----------------------------------------------------

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
      unsubscribeCallRef.current = unsub; 

    } else {
      // Listen for Offer 
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

  const handleNext = async () => {
    // 确保 hangUp 完成清理，尤其是媒体流停止
    await hangUp();
    setTimeout(() => {
        startMatching();
    }, 300); // Brief delay to reset UI visually
  };

  const toggleMic = () => {
    const newMicState = !micEnabled;
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = newMicState;
      });
    }
    setMicEnabled(newMicState);
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
          <h1 className="text-lg font-bold tracking-wide">陌声</h1>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-400 bg-gray-800 px-3 py-1 rounded-full">
          <User className="w-3 h-3" />
          {user ? `ID: ...${user.uid.slice(-4)}` : '认证中...'}
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