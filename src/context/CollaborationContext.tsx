import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useLocation, useNavigate } from 'react-router-dom';
import { Measurement } from '../types';

interface User {
  id: string;
  name: string;
  pageId: string;
  pageName: string;
  cursor: { x: number; y: number } | null;
  color: string;
}

interface CollaborationContextType {
  socket: Socket | null;
  users: User[];
  globalUsers: User[];
  followedUserId: string | null;
  setFollowedUserId: (id: string | null) => void;
  sendCursor: (x: number, y: number) => void;
  sendMeasurementUpdate: (pageId: string, action: 'add' | 'update' | 'delete', measurement: Measurement) => void;
  sendProjectUpdate: (projectId: string) => void;
  updateUser: (name: string, color: string) => void;
  setPageName: (name: string) => void;
  onMeasurementSync: (callback: (data: { action: 'add' | 'update' | 'delete', measurement: Measurement }) => void) => () => void;
  onProjectSync: (callback: (data: { projectId: string }) => void) => () => void;
}

const CollaborationContext = createContext<CollaborationContextType | undefined>(undefined);

export const CollaborationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [globalUsers, setGlobalUsers] = useState<User[]>([]);
  const [followedUserId, setFollowedUserId] = useState<string | null>(null);
  const [currentPageName, setCurrentPageName] = useState('Projects');
  const measurementCallbacks = useRef<((data: any) => void)[]>([]);
  const projectCallbacks = useRef<((data: any) => void)[]>([]);
  const currentUserNameRef = useRef<string>('');
  
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    const storedUser = localStorage.getItem('user');
    const user = storedUser ? JSON.parse(storedUser) : null;
    const userName = user?.username || `User${Math.floor(Math.random() * 1000)}`;
    currentUserNameRef.current = userName;
    
    const storedColor = localStorage.getItem('userColor');
    const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
    const userColor = storedColor || colors[Math.floor(Math.random() * colors.length)];
    if (!storedColor) localStorage.setItem('userColor', userColor);

    // Join with current location
    newSocket.emit('join-page', { 
      pageId: location.pathname, 
      pageName: currentPageName,
      name: userName, 
      color: userColor 
    });

    newSocket.on('room-users', (roomUsers: User[]) => {
      setUsers(roomUsers);
    });

    newSocket.on('global-users', (allUsers: User[]) => {
      setGlobalUsers(allUsers);
    });

    newSocket.on('user-cursor', ({ id, cursor }: { id: string; cursor: { x: number; y: number } }) => {
      setUsers(prev => prev.map(u => u.id === id ? { ...u, cursor } : u));
    });

    newSocket.on('measurement-sync', (data) => {
      measurementCallbacks.current.forEach(cb => cb(data));
    });

    newSocket.on('project-sync', (data) => {
      projectCallbacks.current.forEach(cb => cb(data));
    });

    return () => {
      newSocket.close();
    };
  }, []);

  // Reset page name when returning to the home/projects page
  useEffect(() => {
    if (location.pathname === '/') {
      setCurrentPageName('Projects');
    }
  }, [location.pathname]);

  // Update location when URL changes
  useEffect(() => {
    if (socket) {
      socket.emit('join-page', { 
        pageId: location.pathname, 
        pageName: currentPageName,
        name: currentUserNameRef.current,
        color: localStorage.getItem('userColor') || '#3b82f6'
      });
    }
  }, [location.pathname, socket, currentPageName]);

  // Handle following
  useEffect(() => {
    if (followedUserId && globalUsers.length > 0) {
      const followedUser = globalUsers.find(u => u.id === followedUserId);
      if (followedUser && followedUser.pageId !== location.pathname) {
        navigate(followedUser.pageId);
      }
    }
  }, [followedUserId, globalUsers, location.pathname, navigate]);

  const sendCursor = (x: number, y: number) => {
    socket?.emit('cursor-move', { x, y });
  };

  const sendMeasurementUpdate = (pageId: string, action: 'add' | 'update' | 'delete', measurement: Measurement) => {
    socket?.emit('measurement-update', { pageId, action, measurement });
  };

  const sendProjectUpdate = (projectId: string) => {
    socket?.emit('project-update', { projectId });
  };

  const updateUser = (name: string, color: string) => {
    socket?.emit('update-user', { name, color });
  };

  const onMeasurementSync = (callback: (data: any) => void) => {
    measurementCallbacks.current.push(callback);
    return () => {
      measurementCallbacks.current = measurementCallbacks.current.filter(cb => cb !== callback);
    };
  };

  const onProjectSync = (callback: (data: any) => void) => {
    projectCallbacks.current.push(callback);
    return () => {
      projectCallbacks.current = projectCallbacks.current.filter(cb => cb !== callback);
    };
  };

  return (
    <CollaborationContext.Provider value={{ 
      socket, 
      users, 
      globalUsers,
      followedUserId,
      setFollowedUserId,
      sendCursor, 
      sendMeasurementUpdate, 
      sendProjectUpdate,
      updateUser,
      setPageName: setCurrentPageName,
      onMeasurementSync,
      onProjectSync
    }}>
      {children}
    </CollaborationContext.Provider>
  );
};

export const useCollaboration = () => {
  const context = useContext(CollaborationContext);
  if (!context) {
    throw new Error('useCollaboration must be used within a CollaborationProvider');
  }
  return context;
};
