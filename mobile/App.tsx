import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  Alert,
  SafeAreaView,
  Platform,
} from 'react-native';
import { io, Socket } from 'socket.io-client';

// --- PLATFORM CONDITIONAL WEBRTC IMPORTS ---
let RTCPeerConnection: any;
let RTCIceCandidate: any;
let RTCSessionDescription: any;
let mediaDevices: any;
let RTCView: any;
let MediaStream: any;

if (Platform.OS === 'web') {
  // Use Browser WebRTC API
  RTCPeerConnection = window.RTCPeerConnection;
  RTCIceCandidate = window.RTCIceCandidate;
  RTCSessionDescription = window.RTCSessionDescription;
  mediaDevices = navigator.mediaDevices;
} else {
  // Use react-native-webrtc (Safe import for Expo Go)
  try {
    const WebRTC = require('react-native-webrtc');
    RTCPeerConnection = WebRTC.RTCPeerConnection;
    RTCIceCandidate = WebRTC.RTCIceCandidate;
    RTCSessionDescription = WebRTC.RTCSessionDescription;
    mediaDevices = WebRTC.mediaDevices;
    RTCView = WebRTC.RTCView;
    MediaStream = WebRTC.MediaStream;
  } catch (e) {
    console.warn('WebRTC native module not found. Are you in Expo Go?');
    // If we're here, it means we can't do actual calls on Native, but we can still run the UI.
  }
}

const iceServers = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

type User = { id: string; name: string };

export default function App() {
  const [username, setUsername] = useState('');
  const [serverIP, setServerIP] = useState('');
  const [isJoined, setIsJoined] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'ringing' | 'connected'>('idle');
  const [callerName, setCallerName] = useState('');
  const [isIncomingCall, setIsIncomingCall] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isMicEnabled, setIsMicEnabled] = useState(true);

  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<any>(null);
  const localStreamRef = useRef<any>(null);
  const [localStream, setLocalStream] = useState<any>(null);
  const [remoteStream, setRemoteStream] = useState<any>(null);
  const remoteSocketIdRef = useRef<string | null>(null);
  const offerDataRef = useRef<any>(null);

  // Web-only refs for the <video> elements
  const localVideoRef = useRef<any>(null);
  const remoteVideoRef = useRef<any>(null);

  // Sync streams to <video> tags on Web
  useEffect(() => {
    if (Platform.OS === 'web') {
      if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
      if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [localStream, remoteStream, callStatus]);

  const handleJoin = () => {
    if (!username || !serverIP) {
      Alert.alert('Error', 'Please enter username and server IP');
      return;
    }

    const socketUrl = `http://${serverIP}:3000`;
    // Disconnect existing socket if any
    if (socketRef.current) socketRef.current.disconnect();

    socketRef.current = io(socketUrl, {
      transports: ['polling', 'websocket'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 10,
    });

    socketRef.current.on('connect', () => {
      socketRef.current?.emit('join', username);
      setIsJoined(true);
    });

    socketRef.current.on('user-list', (list: User[]) => {
      setUsers(list.filter((u) => u.id !== socketRef.current?.id));
    });

    socketRef.current.on('offer', async (data) => {
      setCallerName(data.fromName);
      setIsIncomingCall(true);
      setCallStatus('ringing');
      remoteSocketIdRef.current = data.from;
      offerDataRef.current = data;
    });

    socketRef.current.on('answer', async (data) => {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
        setCallStatus('connected');
      }
    });

    socketRef.current.on('ice-candidate', async (data) => {
      if (peerConnectionRef.current) {
        try {
          await peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {}
      }
    });

    socketRef.current.on('call-rejected', () => {
      Alert.alert('Rejected', 'Call was declined');
      endCall();
    });

    socketRef.current.on('end-call', endCall);

    socketRef.current.on('connect_error', () => {
      Alert.alert('Connection Error', `Could not connect to ${socketUrl}`);
    });
  };

  const startLocalStream = async (video: boolean) => {
    if (!mediaDevices) {
      Alert.alert('Error', 'Media devices not supported on this device/app');
      return null;
    }
    try {
      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: video ? { facingMode: 'user' } : false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      return stream;
    } catch (e) {
      console.error(e);
      Alert.alert('Permission Error', 'Cannot access camera or microphone');
      return null;
    }
  };

  const setupPeerConnection = (targetId: string, stream: any) => {
    if (!RTCPeerConnection) return;
    peerConnectionRef.current = new RTCPeerConnection(iceServers);

    stream.getTracks().forEach((track: any) => {
      peerConnectionRef.current.addTrack(track, stream);
    });

    peerConnectionRef.current.onicecandidate = (event: any) => {
      if (event.candidate) {
        socketRef.current?.emit('ice-candidate', { to: targetId, candidate: event.candidate });
      }
    };

    peerConnectionRef.current.ontrack = (event: any) => {
      const [rStream] = event.streams;
      setRemoteStream(rStream);
    };
  };

  const initiateCall = async (targetId: string, targetName: string, video: boolean) => {
    if (!RTCPeerConnection) {
      Alert.alert('Native Module Missing', 'You need a Development Build to make native calls.');
      return;
    }
    setCallStatus('calling');
    setCallerName(targetName);
    remoteSocketIdRef.current = targetId;
    setIsVideoEnabled(video);

    const stream = await startLocalStream(video);
    if (!stream) return;

    setupPeerConnection(targetId, stream);
    const offer = await peerConnectionRef.current.createOffer();
    await peerConnectionRef.current.setLocalDescription(offer);

    socketRef.current?.emit('offer', { to: targetId, offer, isVideo: video });
  };

  const acceptCall = async () => {
    setIsIncomingCall(false);
    setCallStatus('connected');
    const isVideo = offerDataRef.current.isVideo;
    setIsVideoEnabled(isVideo);

    const stream = await startLocalStream(isVideo);
    if (!stream) return;

    setupPeerConnection(offerDataRef.current.from, stream);
    await peerConnectionRef.current.setRemoteDescription(
      new RTCSessionDescription(offerDataRef.current.offer)
    );
    const answer = await peerConnectionRef.current.createAnswer();
    await peerConnectionRef.current.setLocalDescription(answer);

    socketRef.current?.emit('answer', { to: offerDataRef.current.from, answer });
  };

  const rejectCall = () => {
    socketRef.current?.emit('call-rejected', { to: remoteSocketIdRef.current });
    setIsIncomingCall(false);
    setCallStatus('idle');
  };

  const endCall = () => {
    if (remoteSocketIdRef.current) socketRef.current?.emit('end-call', { to: remoteSocketIdRef.current });
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t: any) => t.stop());
      localStreamRef.current = null;
    }
    setLocalStream(null);
    setRemoteStream(null);
    setCallStatus('idle');
    setIsIncomingCall(false);
    remoteSocketIdRef.current = null;
  };

  const toggleMic = () => {
    if (localStreamRef.current) {
      const track = localStreamRef.current.getAudioTracks()[0];
      if (track) {
        track.enabled = !isMicEnabled;
        setIsMicEnabled(!isMicEnabled);
      }
    }
  };

  const toggleVideo = () => {
    if (localStreamRef.current) {
      const track = localStreamRef.current.getVideoTracks()[0];
      if (track) {
        track.enabled = !isVideoEnabled;
        setIsVideoEnabled(!isVideoEnabled);
      }
    }
  };

  // --- UI RENDERING ---
  if (!isJoined) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.title}>MobileCall (Web/Android)</Text>
          <TextInput style={styles.input} placeholder="Username" onChangeText={setUsername} />
          <TextInput style={styles.input} placeholder="Server IP (e.g. 192.168.1.15)" onChangeText={setServerIP} />
          <TouchableOpacity style={styles.button} onPress={handleJoin}>
            <Text style={{ color: '#fff', fontWeight: 'bold' }}>JOIN</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (callStatus === 'idle') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}><Text style={styles.welcome}>Welcome, {username}</Text></View>
        <FlatList
          data={users}
          keyExtractor={(u) => u.id}
          renderItem={({ item }) => (
            <View style={styles.userRow}>
              <Text style={{ fontSize: 18 }}>{item.name}</Text>
              <View style={{ flexDirection: 'row' }}>
                <TouchableOpacity onPress={() => initiateCall(item.id, item.name, false)} style={[styles.callBtn, { backgroundColor: '#4CAF50' }]}><Text style={{ color: '#fff' }}>Voice</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => initiateCall(item.id, item.name, true)} style={[styles.callBtn, { backgroundColor: '#2196F3' }]}><Text style={{ color: '#fff' }}>Video</Text></TouchableOpacity>
              </View>
            </View>
          )}
          ListEmptyComponent={<Text style={{ textAlign: 'center', marginTop: 50 }}>No one else is online.</Text>}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.callContainer}>
      {callStatus === 'ringing' || isIncomingCall ? (
        <View style={styles.center}>
          <Text style={{ color: '#fff', fontSize: 24 }}>{isIncomingCall ? 'Incoming Call from' : 'Calling...'}</Text>
          <Text style={{ color: '#fff', fontSize: 32, fontWeight: 'bold' }}>{callerName}</Text>
          {isIncomingCall ? (
            <View style={{ flexDirection: 'row', marginTop: 40 }}>
              <TouchableOpacity onPress={acceptCall} style={[styles.button, { backgroundColor: '#4CAF50', width: 120 }]}><Text style={{ color: '#fff' }}>Accept</Text></TouchableOpacity>
              <TouchableOpacity onPress={rejectCall} style={[styles.button, { backgroundColor: '#F44336', width: 120 }]}><Text style={{ color: '#fff' }}>Decline</Text></TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={endCall} style={[styles.button, { backgroundColor: '#F44336', marginTop: 40 }]}><Text style={{ color: '#fff' }}>Cancel</Text></TouchableOpacity>
          )}
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <View style={{ flex: 1 }}>
            {Platform.OS === 'web' ? (
              <>
                <video ref={remoteVideoRef} autoPlay playsInline style={styles.fullScreenVideo} />
                {isVideoEnabled && <video ref={localVideoRef} autoPlay playsInline muted style={styles.pipVideo} />}
              </>
            ) : (
              <>
                {remoteStream && <RTCView streamURL={remoteStream.toURL()} style={styles.fullScreenVideo} objectFit="cover" />}
                {localStream && isVideoEnabled && <RTCView streamURL={localStream.toURL()} style={styles.pipVideo} objectFit="cover" zOrder={1} />}
              </>
            )}
            {!remoteStream && <View style={styles.center}><Text style={{ color: '#fff' }}>Connecting Media...</Text></View>}
          </View>
          <View style={styles.controls}>
            <TouchableOpacity onPress={toggleMic} style={[styles.controlBtn, !isMicEnabled && { backgroundColor: 'red' }]}><Text style={{ color: '#fff' }}>{isMicEnabled ? 'Mute' : 'Unmute'}</Text></TouchableOpacity>
            <TouchableOpacity onPress={toggleVideo} style={[styles.controlBtn, !isVideoEnabled && { backgroundColor: 'red' }]}><Text style={{ color: '#fff' }}>{isVideoEnabled ? 'Cam Off' : 'Cam On'}</Text></TouchableOpacity>
            <TouchableOpacity onPress={endCall} style={[styles.controlBtn, { backgroundColor: 'red' }]}><Text style={{ color: '#fff' }}>End</Text></TouchableOpacity>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f9f9f9' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  title: { fontSize: 26, fontWeight: 'bold', marginBottom: 30 },
  input: { width: '100%', padding: 15, backgroundColor: '#fff', borderRadius: 10, marginBottom: 15, borderWidth: 1, borderColor: '#ddd' },
  button: { padding: 15, borderRadius: 10, backgroundColor: '#2196F3', alignItems: 'center', margin: 10, minWidth: 200 },
  header: { padding: 20, backgroundColor: '#2196F3' },
  welcome: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  userRow: { padding: 20, borderBottomWidth: 1, borderColor: '#eee', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fff' },
  callBtn: { padding: 10, borderRadius: 5, marginLeft: 10 },
  callContainer: { flex: 1, backgroundColor: '#000' },
  fullScreenVideo: { flex: 1, backgroundColor: '#222' },
  pipVideo: { position: 'absolute', top: 20, right: 20, width: 100, height: 150, backgroundColor: '#000', borderRadius: 10 },
  controls: { flexDirection: 'row', justifyContent: 'space-around', padding: 30, backgroundColor: 'rgba(0,0,0,0.8)' },
  controlBtn: { padding: 15, backgroundColor: '#444', borderRadius: 10, minWidth: 80, alignItems: 'center' },
});
