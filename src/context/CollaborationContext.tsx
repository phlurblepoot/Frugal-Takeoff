import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Measurement } from '../types';

interface User {
  id: string;
  name: string;
  pageId: string;
  cursor: { x: number; y: number } | null;
  color: string;
}

interface CollaborationContextType {
  socket: Socket | null;
  users: User[];
  sendCursor: (x: number, y: number) => void;
  sendMeasurementUpdate: (pageId: string, action: 'add' | 'update' | 'delete', measurement: Measurement) => void;
  sendProjectUpdate: (projectId: string) => void;
  updateUser: (name: string, color: string) => void;
  onMeasurementSync: (callback: (data: { action: 'add' | 'update' | 'delete', measurement: Measurement }) => void) => () => void;
  onProjectSync: (callback: (data: { projectId: string }) => void) => () => void;
}

const CollaborationContext = createContext<CollaborationContextType | undefined>(undefined);

export const CollaborationProvider: React.FC<{ children: React.ReactNode; pageId?: string; userName?: string; userColor?: string }> = ({ children, pageId, userName, userColor }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const measurementCallbacks = useRef<((data: any) => void)[]>([]);
  const projectCallbacks = useRef<((data: any) => void)[]>([]);

  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    if (pageId && userName) {
      const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
      const color = userColor || colors[Math.floor(Math.random() * colors.length)];
      newSocket.emit('join-page', { pageId, name: userName, color });
    }

    newSocket.on('room-users', (roomUsers: User[]) => {
      setUsers(roomUsers);
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
  }, [pageId, userName, userColor]);

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
      sendCursor, 
      sendMeasurementUpdate, 
      sendProjectUpdate,
      updateUser,
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
