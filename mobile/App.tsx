import React, { useState, useEffect, useRef } from 'react';
import {
  Platform,
  Alert,
  Switch,
  useColorScheme,
} from 'react-native';
import { View, Text, TextInput, Pressable, ScrollView, Image, SafeAreaView } from './src/tw';
import { io, Socket } from 'socket.io-client';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as Network from 'expo-network';
import axios from 'axios';
import { Audio } from 'expo-av';
import { StatusBar } from 'expo-status-bar';

// --- PLATFORM CONDITIONAL WEBRTC IMPORTS ---
let RTCPeerConnection: any;
let RTCIceCandidate: any;
let RTCSessionDescription: any;
let mediaDevices: any;
let RTCView: any;
let MediaStream: any;

if (Platform.OS === 'web') {
  RTCPeerConnection = window.RTCPeerConnection;
  RTCIceCandidate = window.RTCIceCandidate;
  RTCSessionDescription = window.RTCSessionDescription;
  mediaDevices = navigator.mediaDevices;
  if (!mediaDevices) {
    console.warn('navigator.mediaDevices is undefined. Insecure context?');
  }
} else {
  try {
    const WebRTC = require('react-native-webrtc');
    RTCPeerConnection = WebRTC.RTCPeerConnection;
    RTCIceCandidate = WebRTC.RTCIceCandidate;
    RTCSessionDescription = WebRTC.RTCSessionDescription;
    mediaDevices = WebRTC.mediaDevices;
    RTCView = WebRTC.RTCView;
    MediaStream = WebRTC.MediaStream;
  } catch (e) {
    console.warn('WebRTC native module not found.');
  }
}

const iceServers = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

type User = { id: string; name: string; is_voip_eligible?: boolean };

export default function App() {
  const colorScheme = useColorScheme();
  const [view, setView] = useState<'auth' | 'main' | 'call' | 'upload' | 'profile' | 'family' | 'notifications'>('auth');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  
  // Auth State
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [serverIP, setServerIP] = useState('');
  const [isVoipEligible, setIsVoipEligible] = useState(false);
  
  // Family & Notifications State
  const [familyMembers, setFamilyMembers] = useState<any[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<any[]>([]);
  const [notificationsBadge, setNotificationsBadge] = useState(false);

  // App State
  const [isJoined, setIsJoined] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'ringing' | 'connected'>('idle');
  const [callerName, setCallerName] = useState('');
  const [isIncomingCall, setIsIncomingCall] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isMicEnabled, setIsMicEnabled] = useState(true);
  const [callDuration, setCallDuration] = useState(0);

  // Image Processing State
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [faces, setFaces] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [tempImageId, setTempImageId] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<any>(null);
  const localStreamRef = useRef<any>(null);
  const [localStream, setLocalStream] = useState<any>(null);
  const [remoteStream, setRemoteStream] = useState<any>(null);
  const remoteSocketIdRef = useRef<string | null>(null);
  const offerDataRef = useRef<any>(null);

  const soundRef = useRef<Audio.Sound | null>(null);

  const localVideoRef = useRef<any>(null);
  const remoteVideoRef = useRef<any>(null);

  const playRingtone = async () => {
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
      }
      
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: true,
      });

      const { sound } = await Audio.Sound.createAsync(
        require('./assets/audio/Ringtone.mp3'),
        { shouldPlay: true, isLooping: true }
      );
      soundRef.current = sound;
      await sound.playAsync();
    } catch (error) {
      console.warn('Error playing ringtone:', error);
    }
  };

  const stopRingtone = async () => {
    try {
      if (soundRef.current) {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
    } catch (error) {
      console.warn('Error stopping ringtone:', error);
    }
  };

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync();
      }
    };
  }, []);

  const getBaseUrl = () => {
    if (!serverIP) return 'http://localhost:3000'; // Fallback
    
    // Check if the user already specified a protocol
    const trimmedIP = serverIP.trim();
    if (trimmedIP.startsWith('http://') || trimmedIP.startsWith('https://')) {
      return trimmedIP.endsWith('/') ? trimmedIP.slice(0, -1) : trimmedIP;
    }
    
    // Fallback to http with port 3000
    let sanitizedIP = trimmedIP.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    return `http://${sanitizedIP}:3000`;
  };

  const autoDiscoverServer = async () => {
    if (isScanning) return;
    setIsScanning(true);
    setScanProgress(0);
    try {
      const ip = await Network.getIpAddressAsync();
      if (!ip || ip === '0.0.0.0') {
        Alert.alert('Discovery Error', 'Could not get local IP address.');
        setIsScanning(false);
        return;
      }

      const parts = ip.split('.');
      if (parts.length !== 4) {
        setIsScanning(false);
        return;
      }
      
      const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
      const port = 3000;
      let found = false;

      // Scan in batches of 10 to be efficient but not overwhelming
      for (let i = 1; i <= 254; i += 10) {
        if (found) break;
        setScanProgress(Math.floor((i / 254) * 100));
        
        const promises = [];
        for (let j = 0; j < 10 && (i + j) <= 254; j++) {
          const targetIp = `${subnet}.${i + j}`;
          promises.push(
            axios.get(`http://${targetIp}:${port}/api/ping`, { timeout: 500 })
              .then(res => {
                if (res.data?.service === 'mobile-call-server') {
                  setServerIP(targetIp);
                  found = true;
                  return targetIp;
                }
                return null;
              })
              .catch(() => null)
          );
        }
        
        const results = await Promise.all(promises);
        if (results.some(r => r !== null)) break;
      }

      if (!found) {
        Alert.alert('Discovery Finished', 'Server not found automatically. Please enter IP manually.');
      } else {
        Alert.alert('Success', 'Server found and connected!');
      }
    } catch (e) {
      console.error('Discovery error:', e);
    } finally {
      setIsScanning(false);
      setScanProgress(0);
    }
  };

  useEffect(() => {
    if (Platform.OS === 'web') {
      if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
      if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [localStream, remoteStream, callStatus]);

  useEffect(() => {
    let interval: any;
    if (callStatus === 'connected') {
      setCallDuration(0);
      interval = setInterval(() => {
        setCallDuration(prev => prev + 1);
      }, 1000);
    } else {
      setCallDuration(0);
      if (interval) clearInterval(interval);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [callStatus]);

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleAuth = async () => {
    const baseUrl = getBaseUrl();
    try {
      if (authMode === 'register') {
        const res = await axios.post(`${baseUrl}/register`, {
          username: username.trim(),
          password,
        });
        Alert.alert('Success', res.data.message);
        setAuthMode('login');
      } else {
        const res = await axios.post(`${baseUrl}/login`, { username: username.trim(), password });
        const { token, user } = res.data;
        setAuthToken(token);
        setUserProfile(user);
        setIsVoipEligible(user.is_voip_eligible);
        handleJoin(token);
      }
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.message || 'Request failed');
    }
  };

  useEffect(() => {
    if (authToken && view !== 'auth') {
      fetchProfile();
      fetchNotifications();
    }
  }, [authToken, view]);

  const getAuthHeaders = () => ({
    headers: { 'Authorization': `Bearer ${authToken}` }
  });

  const fetchProfile = async () => {
    if (!authToken) return;
    const baseUrl = getBaseUrl();
    try {
      const res = await axios.get(`${baseUrl}/api/profile`, getAuthHeaders());
      setUserProfile(res.data.user);
      setIsVoipEligible(res.data.user.is_voip_eligible);
      if (res.data.user.family_id) {
        fetchFamilyMembers();
      }
    } catch (e) {}
  };

  const fetchNotifications = async () => {
    if (!authToken) return;
    const baseUrl = getBaseUrl();
    try {
      const res = await axios.get(`${baseUrl}/api/notifications`, getAuthHeaders());
      if (res.data.status === 'successful') {
        setPendingInvitations(res.data.notifications);
        setNotificationsBadge(res.data.notifications.length > 0);
      }
    } catch (e) {}
  };

  const fetchFamilyMembers = async () => {
    if (!authToken) return;
    const baseUrl = getBaseUrl();
    try {
      const res = await axios.get(`${baseUrl}/api/family/members`, getAuthHeaders());
      if (res.data.status === 'successful') {
        setFamilyMembers(res.data.members);
      }
    } catch (e) {}
  };

  const handleJoin = (tokenToUse: string | null = authToken) => {
    const socketUrl = getBaseUrl();
    if (socketRef.current) socketRef.current.disconnect();

    socketRef.current = io(socketUrl, {
      transports: ['websocket'],
      forceNew: true,
    });

    socketRef.current.on('connect', () => {
      socketRef.current?.emit('join', { token: tokenToUse });
      // Request user list after a short delay as a safety net for race conditions
      // where the other device joins at nearly the same time
      setTimeout(() => {
        socketRef.current?.emit('request-user-list', {});
      }, 1500);
      setIsJoined(true);
      if (view === 'auth') setView('main');
    });

    socketRef.current.on('user-list', (list: User[]) => {
      setUsers(list.filter((u) => u.id !== socketRef.current?.id));
    });

    socketRef.current.on('offer', async (data) => {
      console.log('OFFER RECEIVED from:', data.fromName);
      setCallerName(data.fromName);
      setIsIncomingCall(true);
      setCallStatus('ringing');
      remoteSocketIdRef.current = data.from;
      offerDataRef.current = data;
      setView('call');
      playRingtone();
    });

    socketRef.current.on('answer', async (data) => {
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
        setCallStatus('connected');
        stopRingtone();
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
      stopRingtone();
      endCall(false);
    });

    socketRef.current.on('end-call', () => {
      stopRingtone();
      endCall(false);
    });
  };

  const pickImage = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: false,
      quality: 1,
    });

    if (!result.canceled) {
      setSelectedImage(result.assets[0].uri);
      uploadGroupImage(result.assets[0].uri);
    }
  };

  const uploadGroupImage = async (uri: string) => {
    const baseUrl = getBaseUrl();
    setUploading(true);
    const formData = new FormData();
    // @ts-ignore
    formData.append('image', {
      uri: Platform.OS === 'android' ? uri : uri.replace('file://', ''),
      name: 'group.jpg',
      type: 'image/jpeg',
    });
    formData.append('username', username);

    try {
      const res = await axios.post(`${baseUrl}/upload-image`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setFaces(res.data.faces);
      setTempImageId(res.data.image_id);
    } catch (e) {
      Alert.alert('Upload Failed', 'Could not detect faces');
    } finally {
      setUploading(false);
    }
  };

  const finalizeFace = async (face: any) => {
    const baseUrl = getBaseUrl();
    try {
      await axios.post(`${baseUrl}/finalize-crop`, {
        username,
        image_id: tempImageId,
        face,
      });
      Alert.alert('Success', 'Profile image updated');
      setView('main');
    } catch (e) {
      Alert.alert('Error', 'Could not finalize face crop');
    }
  };

  const startLocalStream = async (video: boolean) => {
    console.log(`Starting local stream: video=${video}`);
    
    if (Platform.OS === 'web' && !window.isSecureContext) {
      Alert.alert(
        'Insecure Context', 
        'Browsers block camera/mic access on insecure origins. Use "localhost" or "https://" to test.'
      );
      return null;
    }

    if (!mediaDevices) {
      console.error('mediaDevices not available');
      return null;
    }

    try {
      const constraints = {
        audio: true,
        video: video ? { facingMode: 'user' } : false,
      };
      console.log('Requesting getUserMedia with:', constraints);
      const stream = await mediaDevices.getUserMedia(constraints);
      console.log('Stream acquired successfully');
      localStreamRef.current = stream;
      setLocalStream(stream);
      return stream;
    } catch (e: any) {
      console.error('getUserMedia error:', e);
      Alert.alert('Permission Error', `Cannot access camera or microphone: ${e.message}`);
      return null;
    }
  };

  const setupPeerConnection = (targetId: string, stream: any) => {
    if (!RTCPeerConnection) return;
    peerConnectionRef.current = new RTCPeerConnection(iceServers);
    stream.getTracks().forEach((track: any) => peerConnectionRef.current.addTrack(track, stream));
    peerConnectionRef.current.onicecandidate = (event: any) => {
      if (event.candidate) socketRef.current?.emit('ice-candidate', { to: targetId, candidate: event.candidate });
    };
    peerConnectionRef.current.ontrack = (event: any) => setRemoteStream(event.streams[0]);
  };

  const initiateCall = async (targetId: string, targetName: string, video: boolean) => {
    if (!isVoipEligible) {
      Alert.alert('Ineligible', 'You are not eligible for VoIP calls.');
      return;
    }
    try {
      setCallStatus('calling');
      setCallerName(targetName);
      remoteSocketIdRef.current = targetId;
      setIsVideoEnabled(video);
      setView('call');
      playRingtone();

      const stream = await startLocalStream(video);
      if (!stream) {
        stopRingtone();
        return;
      }
      
      if (!RTCPeerConnection) {
        Alert.alert('WebRTC Error', 'WebRTC native module not found. Are you in Expo Go? Use a development client.');
        endCall(false);
        return;
      }

      setupPeerConnection(targetId, stream);
      const offer = await peerConnectionRef.current.createOffer();
      await peerConnectionRef.current.setLocalDescription(offer);
      socketRef.current?.emit('offer', { to: targetId, offer, isVideo: video });
    } catch (e: any) {
      console.error('Call Error:', e);
      Alert.alert('Call Failed', e.message || 'Could not initiate call');
      stopRingtone();
      endCall(false);
    }
  };

  const acceptCall = async () => {
    const data = offerDataRef.current;
    if (!data) return;

    setIsIncomingCall(false);
    setCallStatus('connected');
    remoteSocketIdRef.current = data.from;
    stopRingtone();

    const stream = await startLocalStream(data.isVideo);
    if (!stream) {
      socketRef.current?.emit('call-rejected', { to: data.from });
      endCall(false);
      return;
    }

    if (!RTCPeerConnection) {
      Alert.alert('WebRTC Error', 'WebRTC native module not found.');
      endCall(false);
      return;
    }

    setupPeerConnection(data.from, stream);
    try {
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      socketRef.current?.emit('answer', { to: data.from, answer });
    } catch (e) {
      console.error('Accept call error:', e);
      endCall(true);
    }
  };

  const declineCall = () => {
    if (remoteSocketIdRef.current) {
      socketRef.current?.emit('call-rejected', { to: remoteSocketIdRef.current });
    } else if (offerDataRef.current) {
      socketRef.current?.emit('call-rejected', { to: offerDataRef.current.from });
    }
    endCall(false);
  };

  const endCall = (emitEvent = true) => {
    if (emitEvent && remoteSocketIdRef.current) {
      socketRef.current?.emit('end-call', { to: remoteSocketIdRef.current });
    }
    
    stopRingtone();

    if (peerConnectionRef.current) { 
      peerConnectionRef.current.close(); 
      peerConnectionRef.current = null; 
    }
    if (localStreamRef.current) { 
      localStreamRef.current.getTracks().forEach((t: any) => t.stop()); 
      localStreamRef.current = null; 
    }
    
    remoteSocketIdRef.current = null;
    offerDataRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setCallStatus('idle');
    setIsIncomingCall(false);
    setView('main');
  };

  // --- RENDERING ---

  // --- VIEW RENDERING HELPERS ---

  const renderNavBar = () => (
    <View className="flex-row justify-around py-3 bg-bg-card border-t border-glass-border">
      <Pressable onPress={() => setView('main')} className="items-center justify-center">
        <MaterialIcons name="videocam" size={24} color={view === 'main' ? '#9333EA' : '#666'} />
        <Text className={`text-[10px] mt-1 ${view === 'main' ? 'text-purple-400 font-bold' : 'text-text-dim'}`}>Calls</Text>
      </Pressable>
      <Pressable onPress={() => setView('family')} className="items-center justify-center">
        <MaterialIcons name="people" size={24} color={view === 'family' ? '#9333EA' : '#666'} />
        <Text className={`text-[10px] mt-1 ${view === 'family' ? 'text-purple-400 font-bold' : 'text-text-dim'}`}>Family</Text>
      </Pressable>
      <Pressable onPress={() => setView('notifications')} className="items-center justify-center">
        <View>
          <MaterialIcons name="notifications" size={24} color={view === 'notifications' ? '#9333EA' : '#666'} />
          {notificationsBadge && <View className="absolute -right-0.5 -top-0.5 w-2 h-2 rounded-full bg-red-500" />}
        </View>
        <Text className={`text-[10px] mt-1 ${view === 'notifications' ? 'text-purple-400 font-bold' : 'text-text-dim'}`}>Inbox</Text>
      </Pressable>
      <Pressable onPress={() => setView('profile')} className="items-center justify-center">
        <MaterialIcons name="person" size={24} color={view === 'profile' ? '#9333EA' : '#666'} />
        <Text className={`text-[10px] mt-1 ${view === 'profile' ? 'text-purple-400 font-bold' : 'text-text-dim'}`}>Profile</Text>
      </Pressable>
      <Pressable onPress={() => handleJoin()} className="items-center justify-center">
        <MaterialIcons name="sync" size={24} color={isJoined ? '#10B981' : '#666'} />
        <Text className={`text-[10px] mt-1 ${isJoined ? 'text-emerald-400' : 'text-text-dim'}`}>Sync</Text>
      </Pressable>
    </View>
  );

  if (view === 'auth') {
    return (
      <SafeAreaView className="flex-1 bg-bg-main">
        <StatusBar style="auto" />
        <ScrollView contentContainerClassName="flex-grow justify-center items-center p-5">
          <Text className="text-4xl font-bold mb-2 text-text-main text-center">MobileCall</Text>
          
          <TextInput
            placeholder="Server Address (e.g. 192.168.1.5 or my.server.com)"
            className="w-full p-4 bg-bg-card rounded-xl mb-3 border border-glass-border text-base text-text-main"
            value={serverIP}
            onChangeText={setServerIP}
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor="#666"
          />

          <Pressable 
            className={`p-4 rounded-xl items-center w-full mb-5 border border-glass-border ${isScanning ? 'bg-bg-card' : 'bg-emerald-600'}`}
            onPress={autoDiscoverServer}
            disabled={isScanning}
          >
            <Text className="text-white font-bold">
              {isScanning ? `Scanning Subnet (${scanProgress}%)...` : 'Auto-Discover Server'}
            </Text>
          </Pressable>

          <TextInput
            className="w-full p-4 bg-bg-card rounded-xl mb-3 border border-glass-border text-base text-text-main"
            placeholder="Username"
            value={username}
            onChangeText={setUsername}
            placeholderTextColor="#666"
          />
          <TextInput 
            className="w-full p-4 bg-bg-card rounded-xl mb-3 border border-glass-border text-base text-text-main"
            placeholder="Password" 
            value={password} 
            onChangeText={setPassword} 
            secureTextEntry 
            placeholderTextColor="#666"
          />
          
          <Pressable className="p-4 rounded-xl bg-purple-600 items-center w-full my-2.5 border border-purple-700" onPress={handleAuth}>
            <Text className="text-white font-bold">{authMode.toUpperCase()}</Text>
          </Pressable>
          <Pressable onPress={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>
            <Text className="text-purple-400 mt-2.5">
              {authMode === 'login' ? "Don't have an account? Register" : "Already have an account? Login"}
            </Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (view === 'call') {
    return (
      <SafeAreaView className="flex-1 bg-bg-main">
        <StatusBar style="auto" />
        <View className="flex-grow justify-center items-center p-5">
          <Text className="text-text-main text-2xl">{isIncomingCall ? 'Incoming Call from' : 'Calling...'}</Text>
          <Text className="text-text-main text-3xl font-bold">{callerName}</Text>
          {callStatus === 'connected' && (
            <Text className="text-purple-400 text-xl font-bold mt-2">{formatDuration(callDuration)}</Text>
          )}
          {callStatus === 'ringing' || isIncomingCall ? (
            <View className="flex-row mt-10 gap-5">
              {isIncomingCall && (
                <Pressable onPress={acceptCall} className="w-20 h-20 rounded-full justify-center items-center bg-emerald-500">
                  <MaterialIcons name="call" size={32} color="#fff" />
                </Pressable>
              )}
              <Pressable onPress={declineCall} className="w-20 h-20 rounded-full justify-center items-center bg-red-500">
                <MaterialIcons name="call-end" size={32} color="#fff" />
              </Pressable>
            </View>
          ) : (
            <View className="flex-1 w-full relative">
              {Platform.OS === 'web' ? (
                <video ref={remoteVideoRef} autoPlay playsInline style={{ flex: 1, backgroundColor: '#000', objectFit: 'contain' } as any} />
              ) : (
                remoteStream && <RTCView streamURL={remoteStream.toURL()} style={{ flex: 1, backgroundColor: '#000' }} objectFit="contain" />
              )}
              <Pressable onPress={() => endCall(true)} className="w-20 h-20 rounded-full justify-center items-center bg-red-500 absolute bottom-10 self-center">
                <MaterialIcons name="call-end" size={32} color="#fff" />
              </Pressable>
            </View>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-bg-main">
      <StatusBar style="auto" />
      <View className="flex-1">
        {/* Header */}
        <View className="p-5 pt-10 bg-bg-card flex-row justify-between items-center border-b border-glass-border">
          <Text className="text-text-main text-xl font-bold tracking-widest">{view.toUpperCase()}</Text>
          <Pressable onPress={() => { setAuthToken(null); setView('auth'); }}>
            <MaterialIcons name="logout" size={24} color={colorScheme === 'dark' ? '#fff' : '#000'} />
          </Pressable>
        </View>

        <ScrollView className="flex-1">
          {view === 'main' && (
            <View className="p-5">
              {Platform.OS === 'web' && !window.isSecureContext && (
                <View className="p-4 bg-amber-900/40 rounded-2xl mb-5 border border-amber-800">
                  <Text className="text-amber-300 font-bold mb-1">Insecure Context (HTTP)</Text>
                  <Text className="text-amber-200 text-xs">
                    Browsers block Camera/Mic access on insecure connections. 
                    Please use "localhost" or an HTTPS address to enable calls.
                  </Text>
                </View>
              )}
              <Text className="text-2xl font-bold mb-5 text-text-main">Online Family Members</Text>
              {users.length === 0 ? (
                <Text className="text-center mt-12 text-text-dim">No one else is online in your family.</Text>
              ) : (
                users.map((item) => (
                  <View key={item.id} className="p-4 rounded-2xl bg-bg-card mb-3 flex-row justify-between items-center border border-glass-border">
                    <Text className="text-lg font-medium text-text-main">{item.name}</Text>
                    <View className="flex-row">
                      <Pressable onPress={() => initiateCall(item.id, item.name, false)} className="p-3 rounded-xl ml-2.5 bg-emerald-500">
                        <MaterialIcons name="call" size={20} color="#fff" />
                      </Pressable>
                      <Pressable onPress={() => initiateCall(item.id, item.name, true)} className="p-3 rounded-xl ml-2.5 bg-purple-600">
                        <MaterialIcons name="videocam" size={20} color="#fff" />
                      </Pressable>
                    </View>
                  </View>
                ))
              )}
            </View>
          )}

          {view === 'profile' && (
            <View className="p-5">
              <View className="items-center mb-7">
                <View className="w-24 h-24 rounded-full bg-purple-600 justify-center items-center mb-4">
                  <Text className="text-white text-4xl font-bold">{(userProfile?.username || 'U')[0].toUpperCase()}</Text>
                </View>
                <Text className="text-2xl font-bold text-text-main">{userProfile?.username}</Text>
                <Text className="text-text-dim">{userProfile?.role || 'No Role Set'}</Text>
              </View>

              <View className="p-5 bg-bg-card rounded-2xl mb-5 border border-glass-border">
                <Text className="text-lg font-bold mb-4 text-text-main">Update Profile</Text>
                <View className="mb-5">
                  <Text className="text-sm text-text-dim mb-2.5">Role</Text>
                  <View className="flex-row gap-2.5">
                    {['caregiver', 'grandparent'].map(r => (
                      <Pressable key={r} onPress={() => setUserProfile({...userProfile, role: r})} className={`flex-1 p-3 rounded-xl border items-center ${userProfile?.role === r ? 'bg-purple-600 border-purple-700' : 'bg-bg-main border-glass-border'}`}>
                        <Text className={userProfile?.role === r ? 'text-white' : 'text-text-dim'}>{r.charAt(0).toUpperCase() + r.slice(1)}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
                <Pressable className="p-4 rounded-xl bg-purple-600 items-center border border-purple-700" onPress={async () => {
                   const baseUrl = getBaseUrl();
                   try {
                     await axios.post(`${baseUrl}/api/profile/update`, { role: userProfile.role, age: userProfile.age }, getAuthHeaders());
                     Alert.alert('Success', 'Profile updated');
                   } catch (e) { Alert.alert('Error', 'Update failed'); }
                }}>
                  <Text className="text-white font-bold">Save Changes</Text>
                </Pressable>
              </View>
            </View>
          )}

          {view === 'family' && (
            <View className="p-5">
              {!userProfile?.family_id ? (
                <View className="p-5 bg-bg-card rounded-2xl mb-5 border border-glass-border">
                  <Text className="text-lg font-bold mb-4 text-text-main">Join a Family</Text>
                  <Text className="mb-5 text-text-dim">You are not in a family yet. Create one or wait for an invite.</Text>
                  <Pressable className="p-4 rounded-xl bg-purple-600 items-center border border-purple-700" onPress={async () => {
                    const baseUrl = getBaseUrl();
                    try {
                      await axios.post(`${baseUrl}/api/family/create`, { name: `${username}'s Family` }, getAuthHeaders());
                      fetchProfile();
                    } catch(e) {}
                  }}>
                    <Text className="text-white font-bold">Create New Family</Text>
                  </Pressable>
                </View>
              ) : (
                <>
                  <View className="flex-row justify-between items-center mb-5">
                    <Text className="text-2xl font-bold text-text-main">Family Members</Text>
                    <Pressable onPress={pickImage} className="bg-purple-900/40 p-2 rounded-xl border border-purple-800/50">
                      <MaterialIcons name="add-a-photo" size={24} color="#D8B4FE" />
                    </Pressable>
                  </View>
                  {familyMembers.map((m, i) => (
                    <View key={i} className="flex-row items-center p-4 bg-bg-card rounded-2xl mb-2.5 border border-glass-border">
                       <MaterialIcons name="person" size={24} color="#D8B4FE" />
                       <View className="ml-3 flex-1">
                         <Text className="font-bold text-text-main">{m.username}</Text>
                         <Text className="text-xs text-text-dim capitalize">{m.role}</Text>
                       </View>
                    </View>
                  ))}
                </>
              )}
            </View>
          )}

          {view === 'notifications' && (
            <View className="p-5">
              <Text className="text-2xl font-bold mb-5 text-text-main">Invitations</Text>
              {pendingInvitations.length === 0 ? (
                <Text className="text-center mt-10 text-text-dim">No new invitations.</Text>
              ) : (
                pendingInvitations.map((inv, i) => (
                  <View key={i} className="p-5 bg-bg-card rounded-2xl mb-5 border border-glass-border">
                    <Text className="font-bold text-text-main">Family Invite</Text>
                    <Text className="my-2 text-text-dim">You have been invited to join the {inv.family_name} family.</Text>
                    <View className="flex-row gap-2.5">
                      <Pressable className="flex-1 p-3 rounded-xl bg-emerald-500 items-center justify-center" onPress={async () => {
                        const baseUrl = getBaseUrl();
                        await axios.post(`${baseUrl}/api/notifications/respond`, { invite_id: inv.id, response: 'accepted' }, getAuthHeaders());
                        fetchNotifications();
                        fetchProfile();
                      }}>
                        <Text className="text-white font-bold">Accept</Text>
                      </Pressable>
                      <Pressable className="flex-1 p-3 rounded-xl bg-red-500 items-center justify-center" onPress={async () => {
                        const baseUrl = getBaseUrl();
                        await axios.post(`${baseUrl}/api/notifications/respond`, { invite_id: inv.id, response: 'rejected' }, getAuthHeaders());
                        fetchNotifications();
                      }}>
                        <Text className="text-white font-bold">Decline</Text>
                      </Pressable>
                    </View>
                  </View>
                ))
              )}
            </View>
          )}
        </ScrollView>

        {renderNavBar()}
      </View>
    </SafeAreaView>
  );
}
