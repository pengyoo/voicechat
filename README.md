匿名随机语音聊天 MVP (最小可行产品) 功能实现与代码解释

这个应用是一个基于 WebRTC 的匿名、随机、1对1 实时语音聊天平台。核心思想是利用 Firebase Firestore 作为信令服务器 (Signaling Server) 来交换 WebRTC 连接所需的网络信息，实现浏览器之间的直接点对点 (P2P) 通话。

1. 技术栈概览

前端: React + TypeScript (使用 Vite 构建)

样式: Tailwind CSS (实现响应式和现代 UI)

后端/信令: Firebase Firestore (数据库) & Firebase Auth (匿名认证)

核心通信: WebRTC (用于 P2P 实时音频传输)

2. 核心功能与代码解释

2.1. 匿名用户认证 (Firebase Auth)

用户无需注册或登录。App 启动时会立即进行匿名认证，确保每个会话有一个唯一的身份标识 (uid)。

代码片段 (App.tsx 中的 useEffect):

    const initAuth = async () => {
      try {
        // ... (省略环境特定代码)
        await signInAnonymously(auth); 
      } catch (e) {
        console.error("Auth failed", e);
        setDebugMsg("认证失败，请刷新重试");
      }
    };
    initAuth();
    // ...
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u); // 将认证后的用户对象存储在 state 中
    });


signInAnonymously(auth): 这是实现匿名登录的关键函数。它会创建一个临时的 Firebase 用户，并返回一个唯一的 user.uid，这个 ID 将用于匹配和信令交换。

2.2. 匹配逻辑与队列 (Firestore Transaction)

匹配机制基于一个简单的 FIFO (先进先出) 队列，通过 Firestore 集合 voice_queue 实现。我们使用 Firestore 事务 (Transaction) 来保证匹配的原子性。

代码片段 (startMatching 函数):

// 1. 查找队列中非自己的等待用户
const q = query(queueRef, where('userId', '!=', user.uid), limit(1));

await runTransaction(db, async (transaction) => {
    const querySnapshot = await getDocs(q);
    
    if (!querySnapshot.empty) {
      // --- 情况 A: 找到匹配者 (我是呼叫者 Caller) ---
      const targetDoc = querySnapshot.docs[0];
      // 关键步骤：原子性地从队列中删除匹配者，防止其他人同时抓取
      transaction.delete(targetDoc.ref); 
      
      // 创建通话房间
      const callDocRef = doc(collection(db, 'artifacts', appId, 'public', 'data', 'voice_calls'));
      transaction.set(callDocRef, { /* ... 初始化通话数据 ... */ });
      
      return { role: 'caller', callId: callDocRef.id };
    } else {
      // --- 情况 B: 无人等待 (我是等待者 Waiter) ---
      return { role: 'waiter' };
    }
});


runTransaction: 确保在找到匹配者（情况 A）时，删除操作和创建通话房间操作是原子性的。这意味着，即使有多个用户同时查找到同一个等待者，也只有第一个成功完成事务的用户能够匹配成功。

voice_queue: 这个集合用于存储等待匹配的用户的 userId。

2.3. WebRTC 信令交换 (Firestore Listeners)

信令交换是 WebRTC 建立连接前的握手过程。双方通过 Firestore 交换 SDP Offer/Answer 和 ICE Candidates。

A. 发送 Offer (呼叫者 Caller)

呼叫者创建 RTCPeerConnection 实例。

呼叫者创建并设置 Offer (pc.createOffer() -> pc.setLocalDescription(offer)).

呼叫者将 Offer 写入 Firestore 的通话房间文档。

代码片段 (Caller 逻辑):

// 呼叫者写入 Offer
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
await updateDoc(callDocRef, { offer: { type: offer.type, sdp: offer.sdp } });


B. 接收 Offer 并回复 Answer (等待者 Callee)

等待者通过 onSnapshot 监听自己的 voice_calls 文档。

当 Offer 出现时，等待者读取并设置 Offer (pc.setRemoteDescription(offerDescription)).

等待者创建 Answer (pc.createAnswer() -> pc.setLocalDescription(answer)).

等待者将 Answer 写回 Firestore。

代码片段 (Callee 逻辑):

// Callee 监听 Offer
const unsub = onSnapshot(callDocRef, async (snapshot) => {
     const data = snapshot.data();
     if (!pc.currentRemoteDescription && data?.offer) {
        // ... 设置 Offer, 创建 Answer ...
        await updateDoc(callDocRef, { answer: { type: answer.type, sdp: answer.sdp } });
     }
});


C. 交换 ICE Candidates

双方各自监听 Firestore 中属于对方的 ICE Candidates 子集合。

代码片段 (ICE Logic):

pc.onicecandidate = (event) => {
    // 每次生成一个候选地址，就写入 Firestore
    if (event.candidate) {
        addDoc(myCandidatesCollection, event.candidate.toJSON());
    }
};

// 监听对方发来的候选地址
onSnapshot(candidatesCollection, (snapshot) => {
    snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
            const candidate = new RTCIceCandidate(change.doc.data());
            pc.addIceCandidate(candidate); // 加入 Peer Connection
        }
    });
});


2.4. 语音流处理

一旦连接成功，远程音频流会通过 pc.ontrack 事件接收，并挂载到隐藏的 <audio> 标签上自动播放。

代码片段 (initializePeerConnection):

// 1. 添加本地麦克风轨道
const stream = await getLocalStream();
stream.getTracks().forEach(track => {
  pc.addTrack(track, stream);
});

// 2. 监听远程轨道
pc.ontrack = (event) => {
  if (remoteAudioRef.current) {
    // 将接收到的流设置为隐藏的 audio 元素的源，浏览器会自动播放
    remoteAudioRef.current.srcObject = event.streams[0]; 
    setStatus('connected');
  }
};


2.5. 切换/挂断逻辑 (handleNext / hangUp)

点击“换一个”或“挂断”按钮时，必须执行清理工作，以释放麦克风、关闭 WebRTC 连接并清除 Firestore 中的信令数据。

代码片段 (hangUp 函数):

const hangUp = async () => {
    // 1. 停止 WebRTC 连接
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    // 2. 停止 Firestore 实时监听 (非常重要，否则会持续消耗 Firestore 资源)
    if (unsubscribeCallRef.current) {
      unsubscribeCallRef.current();
      unsubscribeCallRef.current = null;
    }

    // 3. 清理自己的队列条目（如果正在排队）
    if (queueDocIdRef.current) {
       deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'voice_queue', queueDocIdRef.current));
       queueDocIdRef.current = null;
    }
    
    setStatus('idle');
};


handleNext: 调用 hangUp() 清理一切，然后用一个微小的延迟 (setTimeout) 重新调用 startMatching()，实现快速切换。

unsubscribeCallRef.current(): 这是防止内存泄漏和不必要数据库读取的关键。它停止了 Firestore 的实时监听。