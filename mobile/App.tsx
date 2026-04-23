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
import * as SecureStore from 'expo-secure-store';
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

type User = {
  id: string;
  name: string;
  role?: 'caregiver' | 'grandparent';
  user_id?: number;
  is_primary_grandparent?: boolean;
  is_voip_eligible?: boolean;
};
type TimerRef = ReturnType<typeof setTimeout>;
type FamilySettingsState = {
  google_photos_album_url?: string;
  idle_timeout: number;
  primary_grandparent_id?: number | null;
  primary_grandparent_username?: string | null;
};
type DeviceMode = 'standard' | 'primary' | 'controller' | 'viewer' | 'unpaired';

const STORAGE_KEYS = {
  serverUrl: 'mobilecall_server_url',
  authToken: 'mobilecall_auth_token',
  userProfile: 'mobilecall_user_profile',
  deviceId: 'mobilecall_device_id',
};

const storage = {
  async getItem(key: string) {
    if (Platform.OS === 'web') {
      return window.localStorage.getItem(key);
    }
    return SecureStore.getItemAsync(key);
  },
  async setItem(key: string, value: string) {
    if (Platform.OS === 'web') {
      window.localStorage.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  },
  async deleteItem(key: string) {
    if (Platform.OS === 'web') {
      window.localStorage.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};

export default function App() {
  const colorScheme = useColorScheme();
  const [view, setView] = useState<'auth' | 'main' | 'call' | 'upload' | 'profile' | 'family' | 'notifications' | 'family_settings'>('auth');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  
  // Auth State
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<any>(null);
  const [serverIP, setServerIP] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [deviceMode, setDeviceMode] = useState<DeviceMode>('standard');
  const [devicePairing, setDevicePairing] = useState<any>(null);
  const [pairingCodeInput, setPairingCodeInput] = useState('');
  const [isVoipEligible, setIsVoipEligible] = useState(false);
  
  // Family & Notifications State
  const [familyMembers, setFamilyMembers] = useState<any[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<any[]>([]);
  const [notificationsBadge, setNotificationsBadge] = useState(false);
  const [familySettings, setFamilySettings] = useState<FamilySettingsState>({ idle_timeout: 5 });
  const [selectedInviteRoles, setSelectedInviteRoles] = useState<Record<number, 'caregiver' | 'grandparent'>>({});

  // Ambient Mode State
  const [isIdle, setIsIdle] = useState(false);
  const [albumPhotos, setAlbumPhotos] = useState<string[]>([]);
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(0);
  const idleTimerRef = useRef<TimerRef | null>(null);
  const carouselTimerRef = useRef<TimerRef | null>(null);

  // App State
  const [isJoined, setIsJoined] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [callStatus, setCallStatus] = useState<'idle' | 'calling' | 'ringing' | 'connected'>('idle');
  const [callerName, setCallerName] = useState('');
  const [isIncomingCall, setIsIncomingCall] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isMicEnabled, setIsMicEnabled] = useState(true);
  const [callDuration, setCallDuration] = useState(0);
  const [newFamilyName, setNewFamilyName] = useState('');
  const [newFamilyAdminRole, setNewFamilyAdminRole] = useState<'caregiver' | 'grandparent'>('caregiver');

  // Image Processing State
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [faces, setFaces] = useState<any[]>([]);
  const [uploading, setUploading] = useState(false);
  const [tempImageId, setTempImageId] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const peerConnectionRef = useRef<any>(null);
  const viewerPeerConnectionRef = useRef<any>(null);
  const localStreamRef = useRef<any>(null);
  const [localStream, setLocalStream] = useState<any>(null);
  const [remoteStream, setRemoteStream] = useState<any>(null);
  const remoteSocketIdRef = useRef<string | null>(null);
  const offerDataRef = useRef<any>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<number | null>(null);
  const deviceModeRef = useRef<DeviceMode>('standard');
  const isVideoCallRef = useRef(false);
  const viewerSocketIdRef = useRef<string | null>(null);
  const controllerSocketIdRef = useRef<string | null>(null);

  const soundRef = useRef<Audio.Sound | null>(null);

  const localVideoRef = useRef<any>(null);
  const remoteVideoRef = useRef<any>(null);

  const debugLog = (label: string, payload?: any) => {
    if (payload === undefined) {
      console.log(`[PAIR-DEBUG] ${label}`);
      return;
    }
    console.log(`[PAIR-DEBUG] ${label}`, payload);
  };

  const persistServerAddress = async (value: string) => {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      await storage.deleteItem(STORAGE_KEYS.serverUrl);
      return;
    }
    await storage.setItem(STORAGE_KEYS.serverUrl, trimmedValue);
  };

  const persistSession = async (token: string, profile: any, serverAddress: string) => {
    await Promise.all([
      storage.setItem(STORAGE_KEYS.authToken, token),
      storage.setItem(STORAGE_KEYS.userProfile, JSON.stringify(profile)),
      persistServerAddress(serverAddress),
    ]);
  };

  const updateDeviceMode = (nextMode: DeviceMode) => {
    debugLog('updateDeviceMode', {
      previousMode: deviceModeRef.current,
      nextMode,
      deviceId,
    });
    deviceModeRef.current = nextMode;
    setDeviceMode(nextMode);
  };

  const clearPersistedSession = async () => {
    await Promise.all([
      storage.deleteItem(STORAGE_KEYS.authToken),
      storage.deleteItem(STORAGE_KEYS.userProfile),
    ]);
  };

  const handleLogout = async () => {
    try {
      await clearPersistedSession();
    } catch (error) {
      console.warn('Error clearing saved session:', error);
    }
    socketRef.current?.disconnect();
    setAuthToken(null);
    setUserProfile(null);
    currentUserIdRef.current = null;
    setIsJoined(false);
    setUsers([]);
    setView('auth');
  };

  const generateDeviceId = () => `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const fetchDevicePairingStatus = async (tokenToUse: string | null = authToken, profileToUse: any = userProfile, deviceIdToUse: string = deviceId) => {
    debugLog('fetchDevicePairingStatus:start', {
      deviceId: deviceIdToUse,
      role: profileToUse?.role,
      familyId: profileToUse?.family_id,
      username: profileToUse?.username,
    });
    if (!tokenToUse || !profileToUse || !deviceIdToUse) return;

    if (profileToUse.role !== 'grandparent' || !profileToUse.family_id) {
      updateDeviceMode('standard');
      setDevicePairing(null);
      return;
    }

    const baseUrl = getBaseUrl();
    try {
      const res = await axios.get(`${baseUrl}/api/device-pairing/status`, {
        headers: { Authorization: `Bearer ${tokenToUse}` },
        params: { device_id: deviceIdToUse },
      });
      debugLog('fetchDevicePairingStatus:response', res.data);
      updateDeviceMode(res.data.device_mode || 'standard');
      setDevicePairing(res.data.pairing || null);
    } catch (error) {
      console.warn('Error loading device pairing status:', error);
    }
  };

  const startDevicePairing = async () => {
    const baseUrl = getBaseUrl();
    try {
      debugLog('startDevicePairing:request', { deviceId, currentMode: deviceModeRef.current });
      const res = await axios.post(`${baseUrl}/api/device-pairing/start`, { device_id: deviceId }, getAuthHeaders());
      debugLog('startDevicePairing:response', res.data);
      updateDeviceMode(res.data.device_mode);
      setDevicePairing(res.data.pairing);
      handleJoin(authToken, undefined, deviceId);
      Alert.alert('Display Device Ready', `Use code ${res.data.pairing.pairing_code} on the second device. The second device will become the active call controller.`);
    } catch (error: any) {
      Alert.alert('Pairing Error', error.response?.data?.message || 'Could not start pairing');
    }
  };

  const joinDevicePairing = async () => {
    const baseUrl = getBaseUrl();
    try {
      debugLog('joinDevicePairing:request', {
        deviceId,
        pairingCode: pairingCodeInput.trim(),
        currentMode: deviceModeRef.current,
      });
      const res = await axios.post(`${baseUrl}/api/device-pairing/join`, {
        device_id: deviceId,
        pairing_code: pairingCodeInput.trim(),
      }, getAuthHeaders());
      debugLog('joinDevicePairing:response', res.data);
      updateDeviceMode(res.data.device_mode);
      setDevicePairing(res.data.pairing);
      setPairingCodeInput('');
      Alert.alert('Controller Ready', 'This device is now paired as the active call controller.');
      handleJoin(authToken, undefined, deviceId);
    } catch (error: any) {
      Alert.alert('Pairing Error', error.response?.data?.message || 'Could not complete pairing');
    }
  };

  const disconnectDevicePairing = async () => {
    const baseUrl = getBaseUrl();
    try {
      debugLog('disconnectDevicePairing:request', { deviceId, currentMode: deviceModeRef.current });
      await axios.post(`${baseUrl}/api/device-pairing/disconnect`, {}, getAuthHeaders());
      setDevicePairing(null);
      updateDeviceMode(userProfile?.is_primary_grandparent ? 'primary' : 'unpaired');
      Alert.alert('Disconnected', 'This grandparent device pairing has been removed.');
      await fetchDevicePairingStatus(authToken, userProfile, deviceId);
      handleJoin(authToken, undefined, deviceId);
    } catch (error: any) {
      Alert.alert('Disconnect Error', error.response?.data?.message || 'Could not disconnect device pairing');
    }
  };

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

  useEffect(() => {
    let isMounted = true;

    const restoreSession = async () => {
      try {
        const [savedServerUrl, savedToken, savedUserProfile, savedDeviceId] = await Promise.all([
          storage.getItem(STORAGE_KEYS.serverUrl),
          storage.getItem(STORAGE_KEYS.authToken),
          storage.getItem(STORAGE_KEYS.userProfile),
          storage.getItem(STORAGE_KEYS.deviceId),
        ]);

        if (!isMounted) return;

        if (savedServerUrl) {
          setServerIP(savedServerUrl);
        }

        const resolvedDeviceId = savedDeviceId || generateDeviceId();
        setDeviceId(resolvedDeviceId);
        if (!savedDeviceId) {
          await storage.setItem(STORAGE_KEYS.deviceId, resolvedDeviceId);
        }

        if (!savedToken) {
          return;
        }

        setAuthToken(savedToken);
        if (savedUserProfile) {
          try {
            const parsedProfile = JSON.parse(savedUserProfile);
            setUserProfile(parsedProfile);
            currentUserIdRef.current = parsedProfile?.id ?? null;
            setIsVoipEligible(Boolean(parsedProfile?.is_voip_eligible));
          } catch {
            await storage.deleteItem(STORAGE_KEYS.userProfile);
          }
        }
        setView('main');
        handleJoin(savedToken, savedServerUrl || undefined, resolvedDeviceId);
      } catch (error) {
        console.warn('Error restoring saved session:', error);
      }
    };

    restoreSession();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    deviceModeRef.current = deviceMode;
  }, [deviceMode]);

  useEffect(() => {
    persistServerAddress(serverIP).catch((error) => {
      console.warn('Error saving server address:', error);
    });
  }, [serverIP]);

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
        await persistSession(token, user, serverIP || baseUrl);
        setAuthToken(token);
        setUserProfile(user);
        setIsVoipEligible(user.is_voip_eligible);
        setView('main');
        handleJoin(token, baseUrl, deviceId);
      }
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.message || 'Request failed');
    }
  };

  const resetIdleTimer = () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (isIdle) {
      setIsIdle(false);
      setCurrentPhotoIndex(0);
    }
    
    // Only start timer if logged in and not in a call
    if (authToken && callStatus === 'idle') {
      const timeoutMs = (familySettings?.idle_timeout || 5) * 60 * 1000;
      idleTimerRef.current = setTimeout(() => {
        if (albumPhotos.length > 0) {
          setIsIdle(true);
        }
      }, timeoutMs);
    }
  };

  useEffect(() => {
    resetIdleTimer();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [authToken, callStatus, familySettings, albumPhotos]);

  useEffect(() => {
    if (isIdle && albumPhotos.length > 0) {
      carouselTimerRef.current = setInterval(() => {
        setCurrentPhotoIndex(prev => (prev + 1) % albumPhotos.length);
      }, 5000); // Change photo every 5 seconds
    } else {
      if (carouselTimerRef.current) clearInterval(carouselTimerRef.current);
    }
    return () => {
      if (carouselTimerRef.current) clearInterval(carouselTimerRef.current);
    };
  }, [isIdle, albumPhotos]);

  const fetchFamilySettings = async () => {
    if (!authToken) return;
    const baseUrl = getBaseUrl();
    try {
      const res = await axios.get(`${baseUrl}/api/family/settings`, getAuthHeaders());
      if (res.data.status === 'successful') {
        setFamilySettings(res.data.settings);
        if (res.data.settings.google_photos_album_url) {
          fetchFamilyPhotos();
        }
      }
    } catch (e) {}
  };

  const fetchFamilyPhotos = async () => {
    if (!authToken) return;
    const baseUrl = getBaseUrl();
    try {
      const res = await axios.get(`${baseUrl}/api/family/photos`, getAuthHeaders());
      if (res.data.status === 'successful') {
        setAlbumPhotos(res.data.photos);
      }
    } catch (e) {}
  };

  useEffect(() => {
    if (authToken && view !== 'auth') {
      fetchProfile();
      fetchNotifications();
      fetchFamilySettings();
    }
  }, [authToken, view]);

  useEffect(() => {
    if (authToken && userProfile && deviceId) {
      fetchDevicePairingStatus(authToken, userProfile, deviceId);
    }
  }, [authToken, userProfile, deviceId]);

  const getAuthHeaders = () => ({
    headers: { 'Authorization': `Bearer ${authToken}` }
  });

  const fetchProfile = async () => {
    if (!authToken) return;
    const baseUrl = getBaseUrl();
    try {
      const res = await axios.get(`${baseUrl}/api/profile`, getAuthHeaders());
      setUserProfile(res.data.user);
      currentUserIdRef.current = res.data.user?.id ?? null;
      setIsVoipEligible(res.data.user.is_voip_eligible);
      await storage.setItem(STORAGE_KEYS.userProfile, JSON.stringify(res.data.user));
      await fetchDevicePairingStatus(authToken, res.data.user, deviceId);
      if (res.data.user.family_id) {
        fetchFamilyMembers();
      }
    } catch (e) {
      if (axios.isAxiosError(e) && (e.response?.status === 401 || e.response?.status === 403)) {
        await handleLogout();
      }
    }
  };

  const fetchNotifications = async () => {
    if (!authToken) return;
    const baseUrl = getBaseUrl();
    try {
      const res = await axios.get(`${baseUrl}/api/notifications`, getAuthHeaders());
      if (res.data.status === 'successful') {
        setPendingInvitations(res.data.notifications);
        setNotificationsBadge(res.data.notifications.length > 0);
        setSelectedInviteRoles((prev) => {
          const next = { ...prev };
          for (const invitation of res.data.notifications) {
            if (!next[invitation.id]) next[invitation.id] = 'caregiver';
          }
          return next;
        });
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

  const handleJoin = (tokenToUse: string | null = authToken, serverUrlOverride?: string, deviceIdOverride?: string) => {
    const socketUrl = serverUrlOverride || getBaseUrl();
    const resolvedDeviceId = deviceIdOverride || deviceId;
    debugLog('handleJoin:init', {
      socketUrl,
      resolvedDeviceId,
      currentMode: deviceModeRef.current,
      username: userProfile?.username,
      userId: currentUserIdRef.current,
    });
    if (socketRef.current) socketRef.current.disconnect();

    socketRef.current = io(socketUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      forceNew: true,
      secure: socketUrl.startsWith('https://'),
      timeout: 10000,
      reconnection: true,
    });

    socketRef.current.on('connect', () => {
      debugLog('socket:connect', {
        socketId: socketRef.current?.id,
        deviceId: resolvedDeviceId,
        currentMode: deviceModeRef.current,
      });
      socketRef.current?.emit('join', { token: tokenToUse, deviceId: resolvedDeviceId });
      // Request user list after a short delay as a safety net for race conditions
      // where the other device joins at nearly the same time
      setTimeout(() => {
        socketRef.current?.emit('request-user-list', {});
      }, 1500);
      setIsJoined(true);
    });

    socketRef.current.on('connect_error', (error) => {
      debugLog('socket:connect_error', {
        message: error.message,
        deviceId: resolvedDeviceId,
        currentMode: deviceModeRef.current,
      });
      console.warn('Socket connection error:', error.message);
      setIsJoined(false);
    });

    socketRef.current.on('disconnect', () => {
      debugLog('socket:disconnect', {
        socketId: socketRef.current?.id,
        deviceId: resolvedDeviceId,
        currentMode: deviceModeRef.current,
      });
      setIsJoined(false);
    });

    socketRef.current.on('user-list', (list: User[]) => {
      debugLog('socket:user-list', {
        currentUserId: currentUserIdRef.current,
        currentMode: deviceModeRef.current,
        users: list.map((u) => ({ id: u.id, user_id: u.user_id, name: u.name, role: u.role })),
      });
      setUsers(list.filter((u) => u.user_id !== currentUserIdRef.current));
    });

    socketRef.current.on('offer', async (data) => {
      debugLog('socket:offer', {
        from: data.from,
        fromName: data.fromName,
        sessionId: data.sessionId,
        isVideo: data?.isVideo,
        offerType: data?.offer?.type,
        offerLength: data?.offer?.sdp ? data.offer.sdp.length : 0,
        deviceId: resolvedDeviceId,
        deviceModeState: deviceMode,
        deviceModeRef: deviceModeRef.current,
      });
      activeSessionIdRef.current = data.sessionId || null;
      remoteSocketIdRef.current = data.from;
      offerDataRef.current = data;
      isVideoCallRef.current = Boolean(data.isVideo);
      setIsVideoEnabled(Boolean(data.isVideo));
      setCallerName(data.fromName);
      setView('call');

      if (deviceModeRef.current === 'viewer') {
        debugLog('socket:offer:auto_accept_viewer', {
          sessionId: data.sessionId,
          deviceId: resolvedDeviceId,
        });
        setIsIncomingCall(false);
        setCallStatus('ringing');
        await acceptCall(data, true);
        return;
      }

      setIsIncomingCall(true);
      setCallStatus('ringing');
      playRingtone();
    });

    socketRef.current.on('emergency-fall', (data) => {
      Alert.alert('Emergency Alert', `${data.username} may have fallen. Check the family call panel now.`);
    });

    socketRef.current.on('start-emergency-call', (data) => {
      if (userProfile?.is_primary_grandparent) {
        Alert.alert('Emergency Mode', `Emergency call requested for ${data.caregivers?.length || 0} caregiver(s).`);
      } else if (userProfile?.role === 'caregiver') {
        Alert.alert('Emergency Mode', `${data.initiator} triggered an emergency group call.`);
      }
    });

    socketRef.current.on('call-controller-state', (data) => {
      debugLog('socket:call-controller-state', {
        ...data,
        deviceId: resolvedDeviceId,
        deviceModeState: deviceMode,
        deviceModeRef: deviceModeRef.current,
      });
      activeSessionIdRef.current = data.sessionId || null;
      if (typeof data.isVideo === 'boolean') {
        isVideoCallRef.current = data.isVideo;
        setIsVideoEnabled(Boolean(data.isVideo));
      }
      setCallerName(data.callerName || 'Caregiver');
      setView('call');
      setIsIncomingCall(false);
      if (data.phase === 'ringing') {
        setCallStatus('ringing');
      } else if (data.phase === 'connected') {
        setCallStatus('connected');
      }
    });

    socketRef.current.on('call-session-started', (data) => {
      debugLog('socket:call-session-started', {
        ...data,
        deviceId: resolvedDeviceId,
        currentMode: deviceModeRef.current,
      });
      activeSessionIdRef.current = data.sessionId || null;
      viewerSocketIdRef.current = data.localViewerSid || data.viewerSid || null;
      controllerSocketIdRef.current = data.controllerSid || null;
      if (data.isVideo && data.viewerSid && data.controllerSid && data.viewerSid !== data.controllerSid && localStreamRef.current) {
        startViewerMirrorConnection(data.viewerSid).catch((error) => {
          console.warn('Error starting viewer mirror connection:', error);
        });
      }
    });

    socketRef.current.on('answer', async (data) => {
      debugLog('socket:answer', {
        from: data.from,
        hasAnswer: Boolean(data.answer?.sdp),
        answerType: data.answer?.type,
        currentMode: deviceModeRef.current,
        viewerSocketId: viewerSocketIdRef.current,
        controllerSocketId: controllerSocketIdRef.current,
      });
      if (data.from === viewerSocketIdRef.current && viewerPeerConnectionRef.current) {
        await viewerPeerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
        return;
      }
      if (peerConnectionRef.current) {
        await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.answer));
        remoteSocketIdRef.current = data.from;
        setCallStatus('connected');
        stopRingtone();
      }
    });

    socketRef.current.on('ice-candidate', async (data) => {
      debugLog('socket:ice-candidate', {
        from: data.from,
        currentMode: deviceModeRef.current,
        isViewerCandidate: data.from === viewerSocketIdRef.current,
      });
      if (data.from === viewerSocketIdRef.current && viewerPeerConnectionRef.current) {
        try {
          await viewerPeerConnectionRef.current.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {}
        return;
      }
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
    if (!authToken) {
      Alert.alert('Error', 'You must be logged in to upload images');
      return;
    }
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
        headers: {
          'Content-Type': 'multipart/form-data',
          'Authorization': `Bearer ${authToken}`
        },
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
    if (!authToken) {
      Alert.alert('Error', 'You must be logged in to update your profile');
      return;
    }
    const baseUrl = getBaseUrl();
    try {
      await axios.post(`${baseUrl}/finalize-crop`, {
        image_id: tempImageId,
        face,
      }, {
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });
      Alert.alert('Success', 'Profile image updated');
      fetchProfile();
      setView('main');
    } catch (e) {
      Alert.alert('Error', 'Could not finalize face crop');
    }
  };

  const uploadProfilePhoto = async () => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });

    if (!result.canceled) {
      const uri = result.assets[0].uri;
      const baseUrl = getBaseUrl();
      const formData = new FormData();
      // @ts-ignore
      formData.append('image', {
        uri: Platform.OS === 'android' ? uri : uri.replace('file://', ''),
        name: 'profile.jpg',
        type: 'image/jpeg',
      });

      try {
        const res = await axios.post(`${baseUrl}/api/profile/upload-direct`, formData, {
          headers: { 
            'Content-Type': 'multipart/form-data',
            'Authorization': `Bearer ${authToken}`
          },
        });
        Alert.alert('Success', 'Profile photo updated');
        fetchProfile();
      } catch (e) {
        Alert.alert('Error', 'Upload failed');
      }
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

  const setupPeerConnection = (targetId: string, stream?: any, receiveOnly = false) => {
    if (!RTCPeerConnection) return;
    peerConnectionRef.current = new RTCPeerConnection(iceServers);
    if (stream) {
      stream.getTracks().forEach((track: any) => peerConnectionRef.current.addTrack(track, stream));
    } else if (receiveOnly && peerConnectionRef.current.addTransceiver) {
      peerConnectionRef.current.addTransceiver('audio', { direction: 'recvonly' });
      peerConnectionRef.current.addTransceiver('video', { direction: 'recvonly' });
    }
    peerConnectionRef.current.onicecandidate = (event: any) => {
      if (event.candidate) socketRef.current?.emit('ice-candidate', { to: targetId, candidate: event.candidate });
    };
    peerConnectionRef.current.ontrack = (event: any) => setRemoteStream(event.streams[0]);
  };

  const setupViewerPeerConnection = (targetId: string, stream: any) => {
    if (!RTCPeerConnection) return;
    viewerPeerConnectionRef.current = new RTCPeerConnection(iceServers);
    stream.getTracks().forEach((track: any) => viewerPeerConnectionRef.current.addTrack(track, stream));
    viewerPeerConnectionRef.current.onicecandidate = (event: any) => {
      if (event.candidate) socketRef.current?.emit('ice-candidate', { to: targetId, candidate: event.candidate });
    };
  };

  const serializeSessionDescription = (description: any) => ({
    type: description?.type || null,
    sdp: description?.sdp || null,
  });

  const startViewerMirrorConnection = async (viewerSid: string, mirrorStream?: any) => {
    const sourceStream = mirrorStream || localStreamRef.current;
    if (!RTCPeerConnection || !sourceStream) return;
    viewerSocketIdRef.current = viewerSid;
    if (viewerPeerConnectionRef.current) {
      viewerPeerConnectionRef.current.close();
      viewerPeerConnectionRef.current = null;
    }
    setupViewerPeerConnection(viewerSid, sourceStream);
    const offer = await viewerPeerConnectionRef.current.createOffer();
    await viewerPeerConnectionRef.current.setLocalDescription(offer);
    const localOffer = serializeSessionDescription(viewerPeerConnectionRef.current.localDescription);
    socketRef.current?.emit('offer', {
      to: viewerSid,
      offer: localOffer,
      isVideo: true,
      sessionId: activeSessionIdRef.current,
    });
  };

  const initiateCall = async (targetId: string, targetName: string, video: boolean) => {
    if (!isVoipEligible) {
      Alert.alert('Ineligible', 'You are not eligible for VoIP calls.');
      return;
    }
    if (deviceModeRef.current === 'viewer') {
      Alert.alert('Unavailable', 'Use the active call device to place calls. This display device is receive-only.');
      return;
    }
    try {
      debugLog('initiateCall:start', {
        targetId,
        targetName,
        video,
        deviceId,
        currentMode: deviceModeRef.current,
      });
      setCallStatus('calling');
      setCallerName(targetName);
      remoteSocketIdRef.current = null;
      isVideoCallRef.current = video;
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
      const localOffer = serializeSessionDescription(peerConnectionRef.current.localDescription);
      debugLog('initiateCall:emit_offer', {
        targetId,
        type: localOffer.type,
        sdpLength: localOffer.sdp ? localOffer.sdp.length : 0,
        currentMode: deviceModeRef.current,
      });
      socketRef.current?.emit('offer', {
        toUserId: targetId,
        offer: localOffer,
        isVideo: video,
      });
    } catch (e: any) {
      console.error('Call Error:', e);
      Alert.alert('Call Failed', e.message || 'Could not initiate call');
      stopRingtone();
      endCall(false);
    }
  };

  const acceptCall = async (incomingData = offerDataRef.current, receiveOnly = false) => {
    const data = incomingData;
    debugLog('acceptCall:start', {
      hasData: Boolean(data),
      receiveOnly,
      deviceId,
      deviceModeState: deviceMode,
      deviceModeRef: deviceModeRef.current,
      sessionId: data?.sessionId,
      from: data?.from,
      isVideo: data?.isVideo,
      offerType: data?.offer?.type,
      offerLength: data?.offer?.sdp ? data.offer.sdp.length : 0,
    });
    if (!data) return;

    setIsIncomingCall(false);
    setCallStatus('connected');
    remoteSocketIdRef.current = data.from;
    stopRingtone();

    let stream = null;
    if (!receiveOnly) {
      stream = await startLocalStream(data.isVideo);
      if (!stream) {
        socketRef.current?.emit('call-rejected', { to: data.from, sessionId: data.sessionId });
        endCall(false);
        return;
      }
    }

    if (!RTCPeerConnection) {
      Alert.alert('WebRTC Error', 'WebRTC native module not found.');
      endCall(false);
      return;
    }

    setupPeerConnection(data.from, stream, receiveOnly);
    try {
      if (!data.offer?.type || !data.offer?.sdp) {
        debugLog('acceptCall:missing_offer_payload', {
          dataKeys: Object.keys(data || {}),
          offerPayload: data.offer,
          deviceId,
          deviceModeRef: deviceModeRef.current,
        });
        throw new Error('Missing SDP offer payload');
      }
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      const localAnswer = serializeSessionDescription(peerConnectionRef.current.localDescription);
      debugLog('acceptCall:emit_answer', {
        to: data.from,
        sessionId: data.sessionId,
        type: localAnswer.type,
        sdpLength: localAnswer.sdp ? localAnswer.sdp.length : 0,
        receiveOnly,
        currentMode: deviceModeRef.current,
      });
      socketRef.current?.emit('answer', {
        to: data.from,
        answer: localAnswer,
        sessionId: data.sessionId,
      });
      if (
        data.isVideo &&
        stream &&
        data.callerViewerSid &&
        deviceModeRef.current !== 'controller' &&
        deviceModeRef.current !== 'viewer'
      ) {
        startViewerMirrorConnection(data.callerViewerSid, stream).catch((error) => {
          console.warn('Error starting caller viewer mirror connection:', error);
        });
      }
    } catch (e) {
      console.error('Accept call error:', e);
      endCall(true);
    }
  };

  const declineCall = () => {
    if (remoteSocketIdRef.current) {
      socketRef.current?.emit('call-rejected', { to: remoteSocketIdRef.current, sessionId: activeSessionIdRef.current });
    } else if (offerDataRef.current) {
      socketRef.current?.emit('call-rejected', { to: offerDataRef.current.from, sessionId: activeSessionIdRef.current });
    }
    endCall(false);
  };

  const endCall = (emitEvent = true) => {
    debugLog('endCall', {
      emitEvent,
      sessionId: activeSessionIdRef.current,
      remoteSocketId: remoteSocketIdRef.current,
      viewerSocketId: viewerSocketIdRef.current,
      controllerSocketId: controllerSocketIdRef.current,
      currentMode: deviceModeRef.current,
    });
    if (emitEvent) {
      if (activeSessionIdRef.current) {
        socketRef.current?.emit('end-call', { sessionId: activeSessionIdRef.current });
      } else if (remoteSocketIdRef.current) {
        socketRef.current?.emit('end-call', { to: remoteSocketIdRef.current });
      }
    }
    
    stopRingtone();

    if (peerConnectionRef.current) { 
      peerConnectionRef.current.close(); 
      peerConnectionRef.current = null; 
    }
    if (viewerPeerConnectionRef.current) {
      viewerPeerConnectionRef.current.close();
      viewerPeerConnectionRef.current = null;
    }
    if (localStreamRef.current) { 
      localStreamRef.current.getTracks().forEach((t: any) => t.stop()); 
      localStreamRef.current = null; 
    }
    
    remoteSocketIdRef.current = null;
    offerDataRef.current = null;
    activeSessionIdRef.current = null;
    viewerSocketIdRef.current = null;
    controllerSocketIdRef.current = null;
    isVideoCallRef.current = false;
    setLocalStream(null);
    setRemoteStream(null);
    setCallStatus('idle');
    setIsIncomingCall(false);
    setView('main');
  };

  const isSplitGrandparent = userProfile?.role === 'grandparent';

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
    const isControllerDevice = deviceMode === 'controller';
    const isViewerDevice = deviceMode === 'viewer';
    return (
      <SafeAreaView className="flex-1 bg-bg-main">
        <StatusBar style="auto" />
        <View className="flex-grow justify-center items-center p-5">
          <Text className="text-text-main text-2xl">
            {isIncomingCall ? 'Incoming Call from' : isControllerDevice ? 'Call Controller' : 'Calling...'}
          </Text>
          <Text className="text-text-main text-3xl font-bold">{callerName}</Text>
          {(callStatus === 'connected' || isControllerDevice) && (
            <Text className="text-purple-400 text-xl font-bold mt-2">{formatDuration(callDuration)}</Text>
          )}
          {isIncomingCall ? (
            <View className="flex-row mt-10 gap-5">
              <Pressable onPress={() => acceptCall()} className="w-20 h-20 rounded-full justify-center items-center bg-emerald-500">
                <MaterialIcons name="call" size={32} color="#fff" />
              </Pressable>
              {!isViewerDevice && (
                <Pressable onPress={declineCall} className="w-20 h-20 rounded-full justify-center items-center bg-red-500">
                  <MaterialIcons name="call-end" size={32} color="#fff" />
                </Pressable>
              )}
            </View>
          ) : isControllerDevice ? (
            <View className="flex-1 w-full mt-8">
              <Text className="text-text-dim mb-4 text-center">
                {callStatus === 'connected'
                  ? 'This paired device is sending camera and microphone. The primary device is showing the remote webcam.'
                  : 'Preparing camera, microphone, and paired viewer screen.'}
              </Text>
              <View className="flex-1 rounded-3xl overflow-hidden border border-glass-border bg-black">
                {Platform.OS === 'web' ? (
                  <video ref={localVideoRef} autoPlay muted playsInline style={{ flex: 1, backgroundColor: '#000', objectFit: 'cover' } as any} />
                ) : (
                  localStream && <RTCView streamURL={localStream.toURL()} style={{ flex: 1, backgroundColor: '#000' }} objectFit="cover" mirror />
                )}
              </View>
              <View className="items-center mt-6">
                <Pressable onPress={() => endCall(true)} className="w-20 h-20 rounded-full justify-center items-center bg-red-500">
                  <MaterialIcons name="call-end" size={32} color="#fff" />
                </Pressable>
              </View>
            </View>
          ) : callStatus === 'ringing' ? (
            <View className="flex-row mt-10 gap-5">
              {!isViewerDevice && (
                <Pressable onPress={declineCall} className="w-20 h-20 rounded-full justify-center items-center bg-red-500">
                  <MaterialIcons name="call-end" size={32} color="#fff" />
                </Pressable>
              )}
            </View>
          ) : (
            <View className="flex-1 w-full relative">
              {Platform.OS === 'web' ? (
                <video ref={remoteVideoRef} autoPlay playsInline style={{ flex: 1, backgroundColor: '#000', objectFit: 'contain' } as any} />
              ) : (
                remoteStream && <RTCView streamURL={remoteStream.toURL()} style={{ flex: 1, backgroundColor: '#000' }} objectFit="contain" />
              )}
              {!isViewerDevice && (
                <Pressable onPress={() => endCall(true)} className="w-20 h-20 rounded-full justify-center items-center bg-red-500 absolute bottom-10 self-center">
                  <MaterialIcons name="call-end" size={32} color="#fff" />
                </Pressable>
              )}
            </View>
          )}
          {isViewerDevice && callStatus === 'connected' && (
            <View className="absolute bottom-8 self-center bg-black/50 px-4 py-2 rounded-full">
              <Text className="text-white text-xs">Viewer device</Text>
            </View>
          )}
        </View>
      </SafeAreaView>
    );
  }

  if (isIdle && albumPhotos.length > 0) {
    return (
      <Pressable onPress={resetIdleTimer} className="flex-1 bg-black">
        <StatusBar hidden />
        <Image
          key={albumPhotos[currentPhotoIndex]}
          source={{ uri: albumPhotos[currentPhotoIndex] }}
          className="w-full h-full"
          contentFit="contain"
        />
        <View className="absolute bottom-10 left-0 right-0 items-center">
          <View className="bg-black/40 px-6 py-3 rounded-full border border-white/20 backdrop-blur-md">
            <Text className="text-white/80 font-medium tracking-widest text-lg">TOUCH TO START</Text>
          </View>
        </View>
      </Pressable>
    );
  }

  return (
    <SafeAreaView onTouchStart={resetIdleTimer} className="flex-1 bg-bg-main">
      <StatusBar style="auto" />
      <View className="flex-1">
        {/* Header */}
        <View className="p-5 pt-10 bg-bg-card flex-row justify-between items-center border-b border-glass-border">
          <Text className="text-text-main text-xl font-bold tracking-widest">{view.toUpperCase()}</Text>
          <Pressable onPress={handleLogout}>
            <MaterialIcons
              name="logout"
              size={24}
              color={colorScheme === 'dark' ? '#fff' : '#000'}
            />
          </Pressable>
        </View>

        <ScrollView className="flex-1">
          {view === 'main' && (
            <View className="p-5">
              {isSplitGrandparent && (
                <View className="p-4 bg-amber-900/30 rounded-2xl mb-5 border border-amber-700/40">
                  <Text className="text-amber-300 font-bold mb-1">Two-device grandparent mode</Text>
                  <Text className="text-amber-100 text-xs">
                    {deviceMode === 'controller' && devicePairing?.viewer_paired
                      ? 'This device controls the call. The paired viewer device shows the caregiver camera.'
                      : deviceMode === 'viewer'
                        ? 'This device is the viewer screen for caregiver video.'
                        : 'Open Family and complete device pairing so one device becomes the controller and the second becomes the viewer.'}
                  </Text>
                </View>
              )}
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
                    <View className="flex-1">
                      <Text className="text-lg font-medium text-text-main">{item.name}</Text>
                      <Text className="text-xs text-text-dim capitalize">
                        {item.role || 'family member'}{item.is_primary_grandparent ? ' • primary grandparent' : ''}
                      </Text>
                    </View>
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
                <Pressable onPress={uploadProfilePhoto} className="relative">
                  <View className="w-24 h-24 rounded-full bg-purple-600 justify-center items-center mb-4 overflow-hidden">
                    {userProfile?.profile_image ? (
                      <Image 
                        source={{ uri: `${getBaseUrl()}${userProfile.profile_image}` }} 
                        className="w-full h-full"
                      />
                    ) : (
                      <Text className="text-white text-4xl font-bold">{(userProfile?.username || 'U')[0].toUpperCase()}</Text>
                    )}
                  </View>
                  <View className="absolute bottom-4 right-0 bg-purple-500 rounded-full p-1.5 border-2 border-bg-main">
                    <MaterialIcons name="edit" size={16} color="#fff" />
                  </View>
                </Pressable>
                <Text className="text-2xl font-bold text-text-main">{userProfile?.username}</Text>
                <Text className="text-text-dim capitalize">{userProfile?.role || 'No Role Set'}</Text>
              </View>

              <View className="p-5 bg-bg-card rounded-2xl mb-5 border border-glass-border">
                <Text className="text-lg font-bold mb-4 text-text-main">Profile</Text>
                <View className="mb-5">
                  <Text className="text-sm text-text-dim mb-2.5">Family Role</Text>
                  <View className="p-4 rounded-xl border border-glass-border bg-bg-main">
                    <Text className="text-text-main capitalize">{userProfile?.role || 'Assigned when you join a family'}</Text>
                    <Text className="text-xs text-text-dim mt-2">Roles are chosen when creating or accepting a family invitation.</Text>
                  </View>
                </View>
                <Pressable className="p-4 rounded-xl bg-purple-600 items-center border border-purple-700" onPress={async () => {
                   const baseUrl = getBaseUrl();
                   try {
                     await axios.post(`${baseUrl}/api/profile/update`, { age: userProfile.age }, getAuthHeaders());
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
              {isSplitGrandparent && (
                <View className="p-5 bg-bg-card rounded-2xl mb-5 border border-glass-border">
                  <Text className="text-lg font-bold mb-2 text-text-main">Grandparent Device Pairing</Text>
                  <Text className="text-text-dim mb-4">
                    Any grandparent device can use two-device mode automatically: one controller and one viewer.
                  </Text>

                  {deviceMode === 'controller' && (
                    <>
                      <View className="mb-4 p-4 rounded-xl bg-purple-900/30 border border-purple-800/50">
                        <Text className="text-white font-bold">Active call device</Text>
                        <Text className="text-purple-200 mt-1">
                          Second paired device
                        </Text>
                        <Text className="text-text-dim text-xs mt-2">
                          This device handles camera, microphone, audio, and call controls.
                        </Text>
                      </View>
                      <Pressable className="p-4 rounded-xl bg-red-600 items-center border border-red-700 mb-3" onPress={disconnectDevicePairing}>
                        <Text className="text-white font-bold">Disconnect Pairing</Text>
                      </Pressable>
                    </>
                  )}

                  {deviceMode === 'viewer' && (
                    <>
                      <View className="mb-4 p-4 rounded-xl bg-emerald-900/30 border border-emerald-800/50">
                        <Text className="text-white font-bold">Display device</Text>
                        {devicePairing?.pairing_code ? (
                          <Text className="text-emerald-200 mt-1">
                            Pairing code: {devicePairing.pairing_code}
                          </Text>
                        ) : null}
                        <Text className="text-text-dim text-xs mt-2">
                          This device shows the remote webcam. The second paired device handles camera, microphone, and call controls.
                        </Text>
                      </View>
                      <Pressable className="p-4 rounded-xl bg-red-600 items-center border border-red-700 mb-3" onPress={disconnectDevicePairing}>
                        <Text className="text-white font-bold">Disconnect Pairing</Text>
                      </Pressable>
                    </>
                  )}

                  {['unpaired', 'primary', 'standard'].includes(deviceMode) && (
                    <>
                      {deviceMode === 'primary' && (
                        <View className="mb-4 p-4 rounded-xl bg-purple-900/30 border border-purple-800/50">
                          <Text className="text-white font-bold">Primary grandparent device</Text>
                          <Text className="text-text-dim text-xs mt-2">
                            You can still pair a second device. This device will become the display device and the second one will become the active call device.
                          </Text>
                        </View>
                      )}
                      <Pressable className="p-4 rounded-xl bg-purple-600 items-center border border-purple-700 mb-3" onPress={startDevicePairing}>
                        <Text className="text-white font-bold">Start Pairing On This Device</Text>
                      </Pressable>
                      <TextInput
                        className="w-full p-4 bg-bg-main rounded-xl mb-3 border border-glass-border text-base text-text-main"
                        placeholder="Enter pairing code from controller device"
                        value={pairingCodeInput}
                        onChangeText={setPairingCodeInput}
                        autoCapitalize="characters"
                        placeholderTextColor="#666"
                      />
                      <Pressable className="p-4 rounded-xl bg-emerald-600 items-center border border-emerald-700" onPress={joinDevicePairing}>
                        <Text className="text-white font-bold">Join As Active Call Device</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              )}
              {!userProfile?.family_id ? (
                <View className="p-5 bg-bg-card rounded-2xl mb-5 border border-glass-border">
                  <Text className="text-lg font-bold mb-4 text-text-main">Join a Family</Text>
                  <Text className="mb-5 text-text-dim">You are not in a family yet. Create one or wait for an invite.</Text>
                  
                  <TextInput
                    className="w-full p-4 bg-bg-main rounded-xl mb-3 border border-glass-border text-base text-text-main"
                    placeholder="Family Name"
                    value={newFamilyName}
                    onChangeText={setNewFamilyName}
                    placeholderTextColor="#666"
                  />

                  <View className="mb-5">
                    <Text className="text-sm text-text-dim mb-2.5">Your Role</Text>
                    <View className="flex-row gap-2.5">
                      {['caregiver', 'grandparent'].map(r => (
                        <Pressable 
                          key={r} 
                          onPress={() => setNewFamilyAdminRole(r as any)} 
                          className={`flex-1 p-3 rounded-xl border items-center ${newFamilyAdminRole === r ? 'bg-purple-600 border-purple-700' : 'bg-bg-main border-glass-border'}`}
                        >
                          <Text className={newFamilyAdminRole === r ? 'text-white' : 'text-text-dim'}>{r.charAt(0).toUpperCase() + r.slice(1)}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>

                  <Pressable className="p-4 rounded-xl bg-purple-600 items-center border border-purple-700" onPress={async () => {
                    if (!newFamilyName) {
                      Alert.alert('Error', 'Please enter a family name');
                      return;
                    }
                    const baseUrl = getBaseUrl();
                    try {
                      await axios.post(`${baseUrl}/api/family/create`, { 
                        name: newFamilyName,
                        role: newFamilyAdminRole
                      }, getAuthHeaders());
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
                    <View className="flex-row gap-2.5">
                      {userProfile?.is_family_admin && (
                        <Pressable onPress={() => setView('family_settings')} className="bg-purple-900/40 p-2 rounded-xl border border-purple-800/50">
                          <MaterialIcons name="settings" size={24} color="#D8B4FE" />
                        </Pressable>
                      )}
                      <Pressable onPress={pickImage} className="bg-purple-900/40 p-2 rounded-xl border border-purple-800/50">
                        <MaterialIcons name="add-a-photo" size={24} color="#D8B4FE" />
                      </Pressable>
                    </View>
                  </View>
                  {familyMembers.map((m, i) => (
                    <View key={i} className="flex-row items-center p-4 bg-bg-card rounded-2xl mb-2.5 border border-glass-border">
                       <MaterialIcons name="person" size={24} color="#D8B4FE" />
                       <View className="ml-3 flex-1">
                          <Text className="font-bold text-text-main">{m.username}</Text>
                          <Text className="text-xs text-text-dim capitalize">{m.role}</Text>
                       </View>
                       {m.is_admin && <Text className="text-[10px] px-2 py-1 rounded-full bg-emerald-600 text-white mr-2">Admin</Text>}
                       {m.is_primary_grandparent && <Text className="text-[10px] px-2 py-1 rounded-full bg-purple-600 text-white">Primary</Text>}
                    </View>
                  ))}
                </>
              )}
            </View>
          )}

          {view === 'family_settings' && (
            <View className="p-5">
              <Pressable onPress={() => setView('family')} className="flex-row items-center mb-5">
                <MaterialIcons name="arrow-back" size={24} color="#9333EA" />
                <Text className="text-purple-400 font-bold ml-2">Back to Family</Text>
              </Pressable>

              <View className="p-5 bg-bg-card rounded-2xl mb-5 border border-glass-border">
                <Text className="text-lg font-bold mb-4 text-text-main">Primary Grandparent</Text>
                <Text className="text-sm text-text-dim mb-4">Choose the grandparent device that should start emergency calls.</Text>
                {familyMembers.filter((member) => member.role === 'grandparent').length === 0 ? (
                  <Text className="text-text-dim">No grandparent in the family yet.</Text>
                ) : (
                  familyMembers
                    .filter((member) => member.role === 'grandparent')
                    .map((member) => (
                      <Pressable
                        key={member.id}
                        className={`p-4 rounded-xl border mb-3 ${member.is_primary_grandparent ? 'bg-purple-600 border-purple-700' : 'bg-bg-main border-glass-border'}`}
                        onPress={async () => {
                          const baseUrl = getBaseUrl();
                          try {
                            await axios.post(`${baseUrl}/api/family/primary-grandparent`, { member_id: member.id }, getAuthHeaders());
                            fetchFamilyMembers();
                            fetchFamilySettings();
                            fetchProfile();
                          } catch (e) {
                            Alert.alert('Error', 'Could not update the primary grandparent');
                          }
                        }}
                      >
                        <Text className={member.is_primary_grandparent ? 'text-white font-bold' : 'text-text-main font-bold'}>{member.username}</Text>
                        <Text className={member.is_primary_grandparent ? 'text-white/80 text-xs mt-1' : 'text-text-dim text-xs mt-1'}>
                          {member.is_primary_grandparent ? 'Emergency source device' : 'Tap to set as primary'}
                        </Text>
                      </Pressable>
                    ))
                )}
              </View>

              <View className="p-5 bg-bg-card rounded-2xl mb-5 border border-glass-border">
                <Text className="text-lg font-bold mb-4 text-text-main">Ambient Mode</Text>
                
                <Text className="text-sm text-text-dim mb-2.5">Google Photos Album URL</Text>
                <TextInput
                  className="w-full p-4 bg-bg-main rounded-xl mb-3 border border-glass-border text-base text-text-main"
                  placeholder="Paste shared album link here"
                  value={familySettings?.google_photos_album_url}
                  onChangeText={(text) => setFamilySettings({...familySettings, google_photos_album_url: text})}
                  placeholderTextColor="#666"
                />
                
                <Text className="text-sm text-text-dim mb-2.5">Idle Timeout (minutes)</Text>
                <View className="flex-row gap-2.5 mb-5">
                  {[2, 5, 10, 15].map(m => (
                    <Pressable 
                      key={m} 
                      onPress={() => setFamilySettings({...familySettings, idle_timeout: m})} 
                      className={`flex-1 p-3 rounded-xl border items-center ${familySettings?.idle_timeout === m ? 'bg-purple-600 border-purple-700' : 'bg-bg-main border-glass-border'}`}
                    >
                      <Text className={familySettings?.idle_timeout === m ? 'text-white' : 'text-text-dim'}>{m}m</Text>
                    </Pressable>
                  ))}
                </View>

                <Pressable className="p-4 rounded-xl bg-purple-600 items-center border border-purple-700" onPress={async () => {
                   const baseUrl = getBaseUrl();
                   try {
                     await axios.post(`${baseUrl}/api/family/settings`, familySettings, getAuthHeaders());
                     Alert.alert('Success', 'Settings saved');
                     fetchFamilySettings();
                   } catch (e) { Alert.alert('Error', 'Update failed'); }
                }}>
                  <Text className="text-white font-bold">Save Settings</Text>
                </Pressable>
              </View>
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
                    <Text className="text-sm text-text-dim mb-2.5">Choose your role before accepting</Text>
                    <View className="flex-row gap-2.5 mb-4">
                      {(['caregiver', 'grandparent'] as const).map((role) => (
                        <Pressable
                          key={role}
                          className={`flex-1 p-3 rounded-xl border items-center ${selectedInviteRoles[inv.id] === role ? 'bg-purple-600 border-purple-700' : 'bg-bg-main border-glass-border'}`}
                          onPress={() => setSelectedInviteRoles({ ...selectedInviteRoles, [inv.id]: role })}
                        >
                          <Text className={selectedInviteRoles[inv.id] === role ? 'text-white font-bold' : 'text-text-dim'}>
                            {role.charAt(0).toUpperCase() + role.slice(1)}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                    <View className="flex-row gap-2.5">
                      <Pressable className="flex-1 p-3 rounded-xl bg-emerald-500 items-center justify-center" onPress={async () => {
                        const baseUrl = getBaseUrl();
                        await axios.post(`${baseUrl}/api/notifications/respond`, {
                          invite_id: inv.id,
                          response: 'accepted',
                          role: selectedInviteRoles[inv.id] || 'caregiver',
                        }, getAuthHeaders());
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
