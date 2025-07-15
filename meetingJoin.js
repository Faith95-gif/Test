// Global variables
let socket;
let localStream;
let peerConnections = new Map();
let participants = new Map();
let currentUser = null;
let meetingId = null;
let isHost = false;
let currentView = 'sidebar';
let spotlightedParticipant = null;
let pinnedParticipant = null;
let raisedHands = new Set();
let screenShares = new Map();
let isHandRaised = false;
let currentGridPage = 0;
let participantsPerPage = 25;
let totalGridPages = 1;

// DOM elements
let videoContainer, mainVideoSection, secondaryVideosSection;
let micBtn, cameraBtn, screenShareBtn, participantsBtn, reactionsBtn, handBtn, endCallBtn;
let participantsPanel, participantsList, participantsCount;
let viewToggleBtn, emojiPicker, reactionOverlay;
let meetingTitle, meetingTime;
let gridNavigation, gridPrevBtn, gridNextBtn, gridSetIndicator;

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
  initializeDOM();
  initializeSocketConnection();
  setupEventListeners();
  startMeetingTimer();
  
  // Get meeting ID from URL
  const pathParts = window.location.pathname.split('/');
  meetingId = pathParts[pathParts.length - 1];
  
  // Set meeting title
  if (meetingTitle) {
    meetingTitle.textContent = `Meeting ${meetingId}`;
  }
});

function initializeDOM() {
  // Video container elements
  videoContainer = document.getElementById('videoContainer');
  mainVideoSection = document.getElementById('mainVideoSection');
  secondaryVideosSection = document.getElementById('secondaryVideosSection');
  
  // Control buttons
  micBtn = document.getElementById('micBtn');
  cameraBtn = document.getElementById('cameraBtn');
  screenShareBtn = document.getElementById('screenShareBtn');
  participantsBtn = document.getElementById('participantsBtn');
  reactionsBtn = document.getElementById('reactionsBtn');
  handBtn = document.getElementById('handBtn');
  endCallBtn = document.getElementById('endCallBtn');
  
  // Participants panel
  participantsPanel = document.getElementById('participantsPanel');
  participantsList = document.getElementById('participantsList');
  participantsCount = document.getElementById('participantsCount');
  
  // Other elements
  viewToggleBtn = document.getElementById('viewToggleBtn');
  emojiPicker = document.getElementById('emojiPicker');
  reactionOverlay = document.getElementById('reactionOverlay');
  meetingTitle = document.getElementById('meetingTitle');
  meetingTime = document.getElementById('meetingTime');
  
  // Grid navigation elements
  gridNavigation = document.getElementById('gridNavigation');
  gridPrevBtn = document.getElementById('gridPrevBtn');
  gridNextBtn = document.getElementById('gridNextBtn');
  gridSetIndicator = document.getElementById('gridSetIndicator');
}

function initializeSocketConnection() {
  socket = io();
  
  socket.on('connect', () => {
    console.log('Connected to server');
    requestMediaPermissions();
  });
  
  socket.on('joined-meeting', (data) => {
    console.log('Joined meeting:', data);
    meetingId = data.meetingId;
    isHost = data.isHost;
    spotlightedParticipant = data.spotlightedParticipant;
    
    // Update participants
    data.participants.forEach(participant => {
      participants.set(participant.socketId, participant);
    });
    
    // Update raised hands
    if (data.raisedHands) {
      raisedHands = new Set(data.raisedHands);
    }
    
    // Update screen shares
    if (data.screenShares) {
      data.screenShares.forEach(([socketId, shareData]) => {
        screenShares.set(socketId, shareData);
      });
    }
    
    updateParticipantsList();
    updateParticipantsCount();
    renderVideoGrid();
    
    // Signal that we're ready for WebRTC connections
    socket.emit('participant-ready');
  });
  
  socket.on('participant-joined', (data) => {
    console.log('Participant joined:', data.participant);
    participants.set(data.participant.socketId, data.participant);
    updateParticipantsList();
    updateParticipantsCount();
    renderVideoGrid();
  });
  
  socket.on('participant-left', (data) => {
    console.log('Participant left:', data.socketId);
    participants.delete(data.socketId);
    peerConnections.delete(data.socketId);
    updateParticipantsList();
    updateParticipantsCount();
    renderVideoGrid();
    
    // Remove video element
    const videoElement = document.getElementById(`video-${data.socketId}`);
    if (videoElement) {
      videoElement.remove();
    }
  });
  
  socket.on('meeting-ended', () => {
    showToast('Meeting has ended', 'info');
    setTimeout(() => {
      window.location.href = '/';
    }, 2000);
  });
  
  socket.on('meeting-locked', (data) => {
    showModal('Meeting Locked', data.message, () => {
      window.location.href = '/';
    });
  });
  
  socket.on('kicked-from-meeting', () => {
    showToast('You have been removed from the meeting', 'error');
    setTimeout(() => {
      window.location.href = '/';
    }, 2000);
  });
  
  // WebRTC signaling
  socket.on('initiate-connection', async (data) => {
    console.log('Initiating connection with:', data.targetSocketId);
    await createPeerConnection(data.targetSocketId, data.shouldCreateOffer, data.iceServers);
  });
  
  socket.on('offer', async (data) => {
    console.log('Received offer from:', data.sender);
    const pc = peerConnections.get(data.sender);
    if (pc) {
      await pc.setRemoteDescription(data.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      socket.emit('answer', {
        target: data.sender,
        answer: answer
      });
    }
  });
  
  socket.on('answer', async (data) => {
    console.log('Received answer from:', data.sender);
    const pc = peerConnections.get(data.sender);
    if (pc) {
      await pc.setRemoteDescription(data.answer);
    }
  });
  
  socket.on('ice-candidate', async (data) => {
    console.log('Received ICE candidate from:', data.sender);
    const pc = peerConnections.get(data.sender);
    if (pc && data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  });
  
  socket.on('restart-connection', async (data) => {
    console.log('Restarting connection with:', data.targetSocketId);
    const pc = peerConnections.get(data.targetSocketId);
    if (pc) {
      pc.close();
      peerConnections.delete(data.targetSocketId);
    }
    
    // Get ICE servers and recreate connection
    try {
      const response = await fetch('/api/ice-servers');
      const { iceServers } = await response.json();
      await createPeerConnection(data.targetSocketId, true, iceServers);
    } catch (error) {
      console.error('Error restarting connection:', error);
    }
  });
  
  // Meeting events
  socket.on('participant-spotlighted', (data) => {
    spotlightedParticipant = data.spotlightedParticipant;
    data.participants.forEach(participant => {
      participants.set(participant.socketId, participant);
    });
    updateParticipantsList();
    renderVideoGrid();
  });
  
  socket.on('spotlight-removed', (data) => {
    spotlightedParticipant = null;
    data.participants.forEach(participant => {
      participants.set(participant.socketId, participant);
    });
    updateParticipantsList();
    renderVideoGrid();
  });
  
  socket.on('participant-pinned', (data) => {
    pinnedParticipant = data.pinnedParticipant;
    renderVideoGrid();
  });
  
  socket.on('hand-raised', (data) => {
    raisedHands.add(data.socketId);
    const participant = participants.get(data.socketId);
    if (participant) {
      participant.handRaised = true;
    }
    updateParticipantsList();
    renderVideoGrid();
    showToast(`${data.participantName} raised their hand`, 'info');
  });
  
  socket.on('hand-lowered', (data) => {
    raisedHands.delete(data.socketId);
    const participant = participants.get(data.socketId);
    if (participant) {
      participant.handRaised = false;
    }
    updateParticipantsList();
    renderVideoGrid();
  });
  
  socket.on('participant-audio-changed', (data) => {
    const participant = participants.get(data.socketId);
    if (participant) {
      participant.isMuted = data.isMuted;
      updateParticipantsList();
      renderVideoGrid();
    }
  });
  
  socket.on('participant-video-changed', (data) => {
    const participant = participants.get(data.socketId);
    if (participant) {
      participant.isCameraOff = data.isCameraOff;
      updateParticipantsList();
      renderVideoGrid();
    }
  });
  
  socket.on('force-mute', (data) => {
    if (data.isMuted && localStream) {
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = false;
        micBtn.setAttribute('data-active', 'false');
        micBtn.innerHTML = '🔇';
        showToast('You have been muted by the host', 'info');
      }
    }
  });
  
  socket.on('screen-share-started', (data) => {
    screenShares.set(data.participantId, {
      streamId: data.streamId,
      startedAt: new Date()
    });
    
    const participant = participants.get(data.participantId);
    if (participant) {
      participant.isScreenSharing = true;
    }
    
    updateParticipantsList();
    renderVideoGrid();
    showToast(`${data.participantName} started screen sharing`, 'info');
  });
  
  socket.on('screen-share-stopped', (data) => {
    screenShares.delete(data.participantId);
    
    const participant = participants.get(data.participantId);
    if (participant) {
      participant.isScreenSharing = false;
    }
    
    updateParticipantsList();
    renderVideoGrid();
  });
  
  socket.on('reaction-received', (data) => {
    showReaction(data.emoji, data.participantName, data.socketId);
  });
  
  socket.on('meeting-error', (data) => {
    showToast(data.message, 'error');
  });
  
  socket.on('action-error', (data) => {
    showToast(data.message, 'error');
  });
}

async function requestMediaPermissions() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    
    // Set current user info
    const participantName = prompt('Enter your name:') || 'Anonymous';
    currentUser = {
      name: participantName,
      socketId: socket.id
    };
    
    // Join the meeting
    socket.emit('join-meeting', {
      meetingId: meetingId,
      participantName: participantName
    });
    
  } catch (error) {
    console.error('Error accessing media devices:', error);
    showToast('Failed to access camera/microphone', 'error');
  }
}

async function createPeerConnection(targetSocketId, shouldCreateOffer, iceServers) {
  const pc = new RTCPeerConnection({
    iceServers: iceServers || [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  });
  
  peerConnections.set(targetSocketId, pc);
  
  // Add local stream tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
    });
  }
  
  // Handle remote stream
  pc.ontrack = (event) => {
    console.log('Received remote track from:', targetSocketId);
    const remoteStream = event.streams[0];
    updateVideoElement(targetSocketId, remoteStream);
  };
  
  // Handle ICE candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', {
        target: targetSocketId,
        candidate: event.candidate
      });
    }
  };
  
  // Handle connection state changes
  pc.onconnectionstatechange = () => {
    console.log(`Connection state with ${targetSocketId}:`, pc.connectionState);
    
    socket.emit('connection-state-change', {
      targetSocketId: targetSocketId,
      state: pc.connectionState
    });
    
    if (pc.connectionState === 'failed') {
      socket.emit('connection-failed', {
        targetSocketId: targetSocketId
      });
    }
  };
  
  // Create offer if needed
  if (shouldCreateOffer) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      socket.emit('offer', {
        target: targetSocketId,
        offer: offer
      });
    } catch (error) {
      console.error('Error creating offer:', error);
    }
  }
}

function updateVideoElement(socketId, stream) {
  let videoWrapper = document.getElementById(`video-${socketId}`);
  
  if (!videoWrapper) {
    videoWrapper = createVideoWrapper(socketId);
  }
  
  const videoElement = videoWrapper.querySelector('.video-frame');
  if (videoElement && stream) {
    videoElement.srcObject = stream;
  }
}

function createVideoWrapper(socketId) {
  const participant = participants.get(socketId);
  if (!participant) return null;
  
  const videoWrapper = document.createElement('div');
  videoWrapper.className = 'video-wrapper';
  videoWrapper.id = `video-${socketId}`;
  
  const videoElement = document.createElement('video');
  videoElement.className = 'video-frame';
  videoElement.autoplay = true;
  videoElement.playsInline = true;
  videoElement.muted = socketId === socket.id; // Mute own video to prevent feedback
  
  const participantName = document.createElement('div');
  participantName.className = 'participant-name';
  participantName.textContent = participant.name;
  
  videoWrapper.appendChild(videoElement);
  videoWrapper.appendChild(participantName);
  
  // Add badges and indicators
  updateVideoWrapperBadges(videoWrapper, participant);
  
  return videoWrapper;
}

function updateVideoWrapperBadges(videoWrapper, participant) {
  // Remove existing badges
  const existingBadges = videoWrapper.querySelectorAll('.spotlight-badge, .pin-badge, .hand-raised-indicator, .audio-indicator, .video-label');
  existingBadges.forEach(badge => badge.remove());
  
  // Add spotlight badge
  if (participant.isSpotlighted) {
    const spotlightBadge = document.createElement('div');
    spotlightBadge.className = 'spotlight-badge';
    spotlightBadge.innerHTML = '⭐ Spotlight';
    videoWrapper.appendChild(spotlightBadge);
  }
  
  // Add pin badge (for current user's pinned participant)
  if (pinnedParticipant === participant.socketId) {
    const pinBadge = document.createElement('div');
    pinBadge.className = 'pin-badge';
    pinBadge.innerHTML = '📌 Pinned';
    videoWrapper.appendChild(pinBadge);
  }
  
  // Add hand raised indicator
  if (participant.handRaised) {
    const handIndicator = document.createElement('div');
    handIndicator.className = 'hand-raised-indicator';
    handIndicator.innerHTML = '✋ Hand Raised';
    videoWrapper.appendChild(handIndicator);
  }
  
  // Add audio indicator (muted)
  if (participant.isMuted) {
    const audioIndicator = document.createElement('div');
    audioIndicator.className = 'audio-indicator';
    audioIndicator.innerHTML = '🔇';
    videoWrapper.appendChild(audioIndicator);
  }
  
  // Add screen share label
  if (participant.isScreenSharing) {
    const screenLabel = document.createElement('div');
    screenLabel.className = 'video-label';
    screenLabel.innerHTML = '🖥️ Screen Share';
    videoWrapper.appendChild(screenLabel);
    videoWrapper.classList.add('screen-share');
  } else {
    videoWrapper.classList.remove('screen-share');
  }
}

function renderVideoGrid() {
  if (!secondaryVideosSection) return;
  
  const participantArray = Array.from(participants.values());
  const totalParticipants = participantArray.length;
  
  // Update grid pagination
  totalGridPages = Math.ceil(totalParticipants / participantsPerPage);
  currentGridPage = Math.min(currentGridPage, totalGridPages - 1);
  
  if (currentView === 'sidebar') {
    renderSidebarView(participantArray);
  } else {
    renderGridView(participantArray);
  }
  
  updateGridNavigation();
}

function renderSidebarView(participantArray) {
  // Clear existing videos
  mainVideoSection.innerHTML = '';
  secondaryVideosSection.innerHTML = '';
  
  // Find main video (spotlighted, pinned, or first participant)
  let mainParticipant = null;
  
  if (pinnedParticipant) {
    mainParticipant = participants.get(pinnedParticipant);
  } else if (spotlightedParticipant) {
    mainParticipant = participants.get(spotlightedParticipant);
  } else if (participantArray.length > 0) {
    mainParticipant = participantArray[0];
  }
  
  // Render main video
  if (mainParticipant) {
    let mainVideoWrapper = document.getElementById(`video-${mainParticipant.socketId}`);
    if (!mainVideoWrapper) {
      mainVideoWrapper = createVideoWrapper(mainParticipant.socketId);
    }
    
    if (mainVideoWrapper) {
      mainVideoWrapper.classList.add('main-video');
      mainVideoSection.appendChild(mainVideoWrapper);
      
      // Update local stream for own video
      if (mainParticipant.socketId === socket.id && localStream) {
        const videoElement = mainVideoWrapper.querySelector('.video-frame');
        if (videoElement) {
          videoElement.srcObject = localStream;
        }
      }
    }
  }
  
  // Render secondary videos with pagination
  const startIndex = currentGridPage * participantsPerPage;
  const endIndex = Math.min(startIndex + participantsPerPage, participantArray.length);
  const secondaryParticipants = participantArray.slice(startIndex, endIndex)
    .filter(p => p.socketId !== mainParticipant?.socketId);
  
  secondaryParticipants.forEach(participant => {
    let videoWrapper = document.getElementById(`video-${participant.socketId}`);
    if (!videoWrapper) {
      videoWrapper = createVideoWrapper(participant.socketId);
    }
    
    if (videoWrapper) {
      videoWrapper.classList.remove('main-video');
      secondaryVideosSection.appendChild(videoWrapper);
      
      // Update local stream for own video
      if (participant.socketId === socket.id && localStream) {
        const videoElement = videoWrapper.querySelector('.video-frame');
        if (videoElement) {
          videoElement.srcObject = localStream;
        }
      }
    }
  });
}

function renderGridView(participantArray) {
  // Clear existing videos
  mainVideoSection.innerHTML = '';
  secondaryVideosSection.innerHTML = '';
  
  // Calculate pagination for grid view
  const startIndex = currentGridPage * participantsPerPage;
  const endIndex = Math.min(startIndex + participantsPerPage, participantArray.length);
  const visibleParticipants = participantArray.slice(startIndex, endIndex);
  
  // Update grid class based on participant count
  const participantCount = visibleParticipants.length;
  videoContainer.className = `video-container grid-view participants-${participantCount}`;
  
  // Determine if we should use custom layout (for 2-7 participants) or standard grid
  if (participantCount <= 7) {
    secondaryVideosSection.className = 'secondary-videos-section custom-layout';
    renderCustomGridLayout(visibleParticipants);
  } else {
    secondaryVideosSection.className = 'secondary-videos-section standard-grid';
    renderStandardGrid(visibleParticipants);
  }
}

function renderCustomGridLayout(participants) {
  secondaryVideosSection.innerHTML = '';
  
  const participantCount = participants.length;
  
  if (participantCount <= 1) {
    // Single participant - center it
    const gridRow = document.createElement('div');
    gridRow.className = 'grid-row';
    participants.forEach(participant => {
      const videoWrapper = getOrCreateVideoWrapper(participant);
      if (videoWrapper) {
        gridRow.appendChild(videoWrapper);
      }
    });
    secondaryVideosSection.appendChild(gridRow);
    
  } else if (participantCount === 2) {
    // Two participants - side by side
    const gridRow = document.createElement('div');
    gridRow.className = 'grid-row';
    participants.forEach(participant => {
      const videoWrapper = getOrCreateVideoWrapper(participant);
      if (videoWrapper) {
        gridRow.appendChild(videoWrapper);
      }
    });
    secondaryVideosSection.appendChild(gridRow);
    
  } else if (participantCount === 3) {
    // Three participants - 2 in first row, 1 centered in second
    const firstRow = document.createElement('div');
    firstRow.className = 'grid-row';
    
    for (let i = 0; i < 2; i++) {
      const videoWrapper = getOrCreateVideoWrapper(participants[i]);
      if (videoWrapper) {
        firstRow.appendChild(videoWrapper);
      }
    }
    
    const secondRow = document.createElement('div');
    secondRow.className = 'grid-row';
    const videoWrapper = getOrCreateVideoWrapper(participants[2]);
    if (videoWrapper) {
      secondRow.appendChild(videoWrapper);
    }
    
    secondaryVideosSection.appendChild(firstRow);
    secondaryVideosSection.appendChild(secondRow);
    
  } else if (participantCount === 4) {
    // Four participants - 2x2 grid
    const firstRow = document.createElement('div');
    firstRow.className = 'grid-row';
    
    for (let i = 0; i < 2; i++) {
      const videoWrapper = getOrCreateVideoWrapper(participants[i]);
      if (videoWrapper) {
        firstRow.appendChild(videoWrapper);
      }
    }
    
    const secondRow = document.createElement('div');
    secondRow.className = 'grid-row';
    
    for (let i = 2; i < 4; i++) {
      const videoWrapper = getOrCreateVideoWrapper(participants[i]);
      if (videoWrapper) {
        secondRow.appendChild(videoWrapper);
      }
    }
    
    secondaryVideosSection.appendChild(firstRow);
    secondaryVideosSection.appendChild(secondRow);
    
  } else if (participantCount === 5) {
    // Five participants - 3 in first row, 2 centered in second
    const firstRow = document.createElement('div');
    firstRow.className = 'grid-row';
    
    for (let i = 0; i < 3; i++) {
      const videoWrapper = getOrCreateVideoWrapper(participants[i]);
      if (videoWrapper) {
        firstRow.appendChild(videoWrapper);
      }
    }
    
    const secondRow = document.createElement('div');
    secondRow.className = 'grid-row';
    
    for (let i = 3; i < 5; i++) {
      const videoWrapper = getOrCreateVideoWrapper(participants[i]);
      if (videoWrapper) {
        secondRow.appendChild(videoWrapper);
      }
    }
    
    secondaryVideosSection.appendChild(firstRow);
    secondaryVideosSection.appendChild(secondRow);
    
  } else if (participantCount === 6) {
    // Six participants - 3x2 grid
    const firstRow = document.createElement('div');
    firstRow.className = 'grid-row';
    
    for (let i = 0; i < 3; i++) {
      const videoWrapper = getOrCreateVideoWrapper(participants[i]);
      if (videoWrapper) {
        firstRow.appendChild(videoWrapper);
      }
    }
    
    const secondRow = document.createElement('div');
    secondRow.className = 'grid-row';
    
    for (let i = 3; i < 6; i++) {
      const videoWrapper = getOrCreateVideoWrapper(participants[i]);
      if (videoWrapper) {
        secondRow.appendChild(videoWrapper);
      }
    }
    
    secondaryVideosSection.appendChild(firstRow);
    secondaryVideosSection.appendChild(secondRow);
    
  } else if (participantCount === 7) {
    // Seven participants - 3, 3, 1 centered
    const firstRow = document.createElement('div');
    firstRow.className = 'grid-row';
    
    for (let i = 0; i < 3; i++) {
      const videoWrapper = getOrCreateVideoWrapper(participants[i]);
      if (videoWrapper) {
        firstRow.appendChild(videoWrapper);
      }
    }
    
    const secondRow = document.createElement('div');
    secondRow.className = 'grid-row';
    
    for (let i = 3; i < 6; i++) {
      const videoWrapper = getOrCreateVideoWrapper(participants[i]);
      if (videoWrapper) {
        secondRow.appendChild(videoWrapper);
      }
    }
    
    const thirdRow = document.createElement('div');
    thirdRow.className = 'grid-row';
    const videoWrapper = getOrCreateVideoWrapper(participants[6]);
    if (videoWrapper) {
      thirdRow.appendChild(videoWrapper);
    }
    
    secondaryVideosSection.appendChild(firstRow);
    secondaryVideosSection.appendChild(secondRow);
    secondaryVideosSection.appendChild(thirdRow);
  }
}

function renderStandardGrid(participants) {
  secondaryVideosSection.innerHTML = '';
  
  participants.forEach(participant => {
    const videoWrapper = getOrCreateVideoWrapper(participant);
    if (videoWrapper) {
      secondaryVideosSection.appendChild(videoWrapper);
    }
  });
}

function getOrCreateVideoWrapper(participant) {
  let videoWrapper = document.getElementById(`video-${participant.socketId}`);
  if (!videoWrapper) {
    videoWrapper = createVideoWrapper(participant.socketId);
  }
  
  if (videoWrapper) {
    videoWrapper.classList.remove('main-video');
    updateVideoWrapperBadges(videoWrapper, participant);
    
    // Update local stream for own video
    if (participant.socketId === socket.id && localStream) {
      const videoElement = videoWrapper.querySelector('.video-frame');
      if (videoElement) {
        videoElement.srcObject = localStream;
      }
    }
  }
  
  return videoWrapper;
}

function updateGridNavigation() {
  if (!gridNavigation) return;
  
  const totalParticipants = participants.size;
  
  if (currentView === 'grid' && totalParticipants > participantsPerPage) {
    gridNavigation.style.display = 'flex';
    
    if (gridPrevBtn) {
      gridPrevBtn.disabled = currentGridPage === 0;
    }
    
    if (gridNextBtn) {
      gridNextBtn.disabled = currentGridPage >= totalGridPages - 1;
    }
    
    if (gridSetIndicator) {
      const startIndex = currentGridPage * participantsPerPage + 1;
      const endIndex = Math.min((currentGridPage + 1) * participantsPerPage, totalParticipants);
      gridSetIndicator.textContent = `${startIndex}-${endIndex} of ${totalParticipants}`;
    }
  } else {
    gridNavigation.style.display = 'none';
  }
}

function setupEventListeners() {
  // Control buttons
  if (micBtn) {
    micBtn.addEventListener('click', toggleMicrophone);
  }
  
  if (cameraBtn) {
    cameraBtn.addEventListener('click', toggleCamera);
  }
  
  if (screenShareBtn) {
    screenShareBtn.addEventListener('click', toggleScreenShare);
  }
  
  if (participantsBtn) {
    participantsBtn.addEventListener('click', toggleParticipantsPanel);
  }
  
  if (reactionsBtn) {
    reactionsBtn.addEventListener('click', toggleEmojiPicker);
  }
  
  if (handBtn) {
    handBtn.addEventListener('click', toggleHandRaise);
  }
  
  if (endCallBtn) {
    endCallBtn.addEventListener('click', endCall);
  }
  
  if (viewToggleBtn) {
    viewToggleBtn.addEventListener('click', toggleView);
  }
  
  // Grid navigation
  if (gridPrevBtn) {
    gridPrevBtn.addEventListener('click', () => {
      if (currentGridPage > 0) {
        currentGridPage--;
        renderVideoGrid();
      }
    });
  }
  
  if (gridNextBtn) {
    gridNextBtn.addEventListener('click', () => {
      if (currentGridPage < totalGridPages - 1) {
        currentGridPage++;
        renderVideoGrid();
      }
    });
  }
  
  // Participants panel
  const closeParticipantsBtn = document.getElementById('closeParticipants');
  if (closeParticipantsBtn) {
    closeParticipantsBtn.addEventListener('click', toggleParticipantsPanel);
  }
  
  // Emoji picker
  const emojiButtons = document.querySelectorAll('.emoji-btn');
  emojiButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const emoji = e.target.textContent;
      sendReaction(emoji);
      hideEmojiPicker();
    });
  });
  
  // Close emoji picker when clicking outside
  document.addEventListener('click', (e) => {
    if (emojiPicker && !emojiPicker.contains(e.target) && e.target !== reactionsBtn) {
      hideEmojiPicker();
    }
  });
  
  // Meeting title click
  if (meetingTitle) {
    meetingTitle.addEventListener('click', showMeetingInfo);
  }
}

function toggleMicrophone() {
  if (!localStream) return;
  
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    const isMuted = !audioTrack.enabled;
    
    micBtn.setAttribute('data-active', isMuted ? 'false' : 'true');
    micBtn.innerHTML = isMuted ? '🔇' : '🎤';
    
    socket.emit('toggle-mic', { isMuted });
  }
}

function toggleCamera() {
  if (!localStream) return;
  
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    const isCameraOff = !videoTrack.enabled;
    
    cameraBtn.setAttribute('data-active', isCameraOff ? 'false' : 'true');
    cameraBtn.innerHTML = isCameraOff ? '📹' : '📷';
    
    socket.emit('toggle-camera', { isCameraOff });
  }
}

async function toggleScreenShare() {
  try {
    if (screenShareBtn.getAttribute('data-active') === 'true') {
      // Stop screen sharing
      stopScreenShare();
    } else {
      // Start screen sharing
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });
      
      // Replace video track in all peer connections
      const videoTrack = screenStream.getVideoTracks()[0];
      
      peerConnections.forEach(async (pc) => {
        const sender = pc.getSenders().find(s => 
          s.track && s.track.kind === 'video'
        );
        if (sender) {
          await sender.replaceTrack(videoTrack);
        }
      });
      
      // Update local video
      const localVideo = document.querySelector(`#video-${socket.id} .video-frame`);
      if (localVideo) {
        localVideo.srcObject = screenStream;
      }
      
      screenShareBtn.setAttribute('data-active', 'true');
      screenShareBtn.innerHTML = '🛑';
      
      socket.emit('start-screen-share', {
        streamId: screenStream.id
      });
      
      // Handle screen share end
      videoTrack.onended = () => {
        stopScreenShare();
      };
    }
  } catch (error) {
    console.error('Error toggling screen share:', error);
    showToast('Failed to share screen', 'error');
  }
}

async function stopScreenShare() {
  try {
    // Get camera stream back
    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    
    // Replace video track in all peer connections
    const videoTrack = cameraStream.getVideoTracks()[0];
    
    peerConnections.forEach(async (pc) => {
      const sender = pc.getSenders().find(s => 
        s.track && s.track.kind === 'video'
      );
      if (sender) {
        await sender.replaceTrack(videoTrack);
      }
    });
    
    // Update local video
    const localVideo = document.querySelector(`#video-${socket.id} .video-frame`);
    if (localVideo) {
      localVideo.srcObject = cameraStream;
    }
    
    // Update local stream reference
    localStream = cameraStream;
    
    screenShareBtn.setAttribute('data-active', 'false');
    screenShareBtn.innerHTML = '🖥️';
    
    socket.emit('stop-screen-share');
    
  } catch (error) {
    console.error('Error stopping screen share:', error);
  }
}

function toggleParticipantsPanel() {
  if (participantsPanel) {
    participantsPanel.classList.toggle('open');
    videoContainer.classList.toggle('participants-open');
  }
}

function toggleView() {
  currentView = currentView === 'sidebar' ? 'grid' : 'sidebar';
  
  videoContainer.className = `video-container ${currentView}-view`;
  
  if (viewToggleBtn) {
    const icon = currentView === 'sidebar' ? '⊞' : '⊟';
    const text = currentView === 'sidebar' ? 'Grid View' : 'Sidebar View';
    viewToggleBtn.innerHTML = `${icon} <span>${text}</span>`;
  }
  
  // Reset grid page when switching views
  currentGridPage = 0;
  renderVideoGrid();
}

function toggleEmojiPicker() {
  if (emojiPicker) {
    emojiPicker.classList.toggle('show');
    
    if (emojiPicker.classList.contains('show')) {
      // Position the emoji picker above the reactions button
      const rect = reactionsBtn.getBoundingClientRect();
      emojiPicker.style.left = `${rect.left + rect.width / 2}px`;
      emojiPicker.style.bottom = `${window.innerHeight - rect.top + 10}px`;
    }
  }
}

function hideEmojiPicker() {
  if (emojiPicker) {
    emojiPicker.classList.remove('show');
  }
}

function toggleHandRaise() {
  isHandRaised = !isHandRaised;
  
  if (isHandRaised) {
    socket.emit('raise-hand');
    handBtn.setAttribute('data-active', 'true');
    handBtn.innerHTML = '✋';
  } else {
    socket.emit('lower-hand');
    handBtn.setAttribute('data-active', 'false');
    handBtn.innerHTML = '🖐️';
  }
}

function sendReaction(emoji) {
  socket.emit('send-reaction', {
    emoji: emoji,
    timestamp: Date.now()
  });
}

function showReaction(emoji, participantName, socketId) {
  // Create floating reaction
  const reaction = document.createElement('div');
  reaction.className = 'floating-reaction';
  
  const emojiDiv = document.createElement('div');
  emojiDiv.className = 'floating-emoji';
  emojiDiv.textContent = emoji;
  
  const nameDiv = document.createElement('div');
  nameDiv.className = 'floating-name';
  nameDiv.textContent = participantName;
  
  reaction.appendChild(emojiDiv);
  reaction.appendChild(nameDiv);
  
  // Position randomly on screen
  reaction.style.left = Math.random() * (window.innerWidth - 100) + 'px';
  reaction.style.top = Math.random() * (window.innerHeight - 100) + 'px';
  
  reactionOverlay.appendChild(reaction);
  
  // Animate
  setTimeout(() => {
    reaction.classList.add('animate');
  }, 100);
  
  // Remove after animation
  setTimeout(() => {
    reaction.remove();
  }, 3000);
}

function updateParticipantsList() {
  if (!participantsList) return;
  
  participantsList.innerHTML = '';
  
  const participantArray = Array.from(participants.values());
  
  participantArray.forEach(participant => {
    const participantItem = document.createElement('div');
    participantItem.className = 'participant-item';
    
    const avatar = document.createElement('div');
    avatar.className = 'participant-avatar';
    avatar.textContent = participant.name.charAt(0).toUpperCase();
    
    const info = document.createElement('div');
    info.className = 'participant-info';
    
    const name = document.createElement('div');
    name.className = 'participant-name';
    name.textContent = participant.name;
    
    const role = document.createElement('div');
    role.className = 'participant-role';
    
    const roleBadge = document.createElement('span');
    roleBadge.className = `role-badge ${participant.isHost ? 'host' : participant.isCoHost ? 'cohost' : 'participant'}`;
    roleBadge.textContent = participant.isHost ? 'Host' : participant.isCoHost ? 'Co-Host' : 'Participant';
    
    role.appendChild(roleBadge);
    
    info.appendChild(name);
    info.appendChild(role);
    
    const status = document.createElement('div');
    status.className = 'participant-status';
    
    if (participant.isMuted) {
      const mutedIcon = document.createElement('div');
      mutedIcon.className = 'status-icon muted';
      mutedIcon.innerHTML = '🔇';
      status.appendChild(mutedIcon);
    }
    
    if (participant.isCameraOff) {
      const cameraIcon = document.createElement('div');
      cameraIcon.className = 'status-icon camera-off';
      cameraIcon.innerHTML = '📹';
      status.appendChild(cameraIcon);
    }
    
    if (participant.handRaised) {
      const handIcon = document.createElement('div');
      handIcon.className = 'status-icon hand-raised-icon';
      handIcon.innerHTML = '✋';
      status.appendChild(handIcon);
    }
    
    participantItem.appendChild(avatar);
    participantItem.appendChild(info);
    participantItem.appendChild(status);
    
    participantsList.appendChild(participantItem);
  });
}

function updateParticipantsCount() {
  if (participantsCount) {
    participantsCount.textContent = participants.size;
  }
}

function endCall() {
  if (confirm('Are you sure you want to leave the meeting?')) {
    // Clean up local stream
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    
    // Close all peer connections
    peerConnections.forEach(pc => pc.close());
    
    // Disconnect from socket
    if (socket) {
      socket.disconnect();
    }
    
    // Redirect to home
    window.location.href = '/';
  }
}

function showMeetingInfo() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>Meeting Information</h3>
        <button class="close-btn">&times;</button>
      </div>
      <div class="modal-body">
        <div class="info-item">
          <label>Meeting ID:</label>
          <div class="meeting-id-display">
            <span>${meetingId}</span>
            <button class="copy-btn" onclick="copyMeetingId('${meetingId}')">Copy</button>
          </div>
        </div>
        <div class="info-item">
          <label>Participants:</label>
          <span>${participants.size}</span>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Close modal handlers
  const closeBtn = modal.querySelector('.close-btn');
  closeBtn.addEventListener('click', () => {
    modal.remove();
  });
  
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
    }
  });
}

function copyMeetingId(meetingId) {
  navigator.clipboard.writeText(meetingId).then(() => {
    showToast('Meeting ID copied to clipboard', 'info');
  });
}

function showModal(title, message, onConfirm) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>${title}</h3>
      </div>
      <div class="modal-body">
        <p>${message}</p>
        <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove(); ${onConfirm ? 'onConfirm()' : ''}">OK</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  if (onConfirm) {
    window.onConfirm = onConfirm;
  }
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  
  document.body.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('show');
  }, 100);
  
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 3000);
}

function startMeetingTimer() {
  const startTime = Date.now();
  
  setInterval(() => {
    const elapsed = Date.now() - startTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    
    if (meetingTime) {
      meetingTime.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
  }, 1000);
}