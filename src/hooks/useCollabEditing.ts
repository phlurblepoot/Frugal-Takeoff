import { useEffect, useRef, useState } from 'react';
import { useCollaboration, type SessionView } from '../context/CollaborationContext';
import { CLIENT_SESSION_ID } from '../utils/clientSession';
import type { EntityType, EntityChangedEvent } from './useLiveQuery';

export interface CollabEditingState {
  othersEditing: SessionView[];               // sessions (not mine) editing this entity
  remoteChange: EntityChangedEvent | null;    // set when a foreign change arrived while dirty
  keepMineVersion: number | null;             // adopt into the save payload after "Keep mine"
  reviewMerge: () => void;                    // calls onFresh (parent refetch → key-remount) and clears state
  keepMine: () => void;                       // records the remote version, clears the banner
}

export function useCollabEditing(args: {
  type: EntityType;
  id: string;
  isDirty: () => boolean;
  onFresh: () => void;    // parent's refetch — editors are remounted via key={id:version}
}): CollabEditingState {
  const { socket, sessions, mySessionId } = useCollaboration();
  const [remoteChange, setRemoteChange] = useState<EntityChangedEvent | null>(null);
  const [keepMineVersion, setKeepMineVersion] = useState<number | null>(null);
  const argsRef = useRef(args);
  argsRef.current = args;

  useEffect(() => {
    if (!socket) return;
    const declare = () => socket.emit('set-editing', { type: args.type, id: args.id });
    declare();
    socket.on('connect', declare); // reconnect wipes server session state
    const onEvent = (ev: EntityChangedEvent) => {
      if (ev.bySessionId === CLIENT_SESSION_ID) return;
      if (ev.type !== argsRef.current.type || ev.id !== argsRef.current.id) return;
      if (!argsRef.current.isDirty()) argsRef.current.onFresh();
      else setRemoteChange(ev);
    };
    socket.on('entity-changed', onEvent);
    return () => {
      socket.off('connect', declare);
      socket.off('entity-changed', onEvent);
      socket.emit('set-editing', null);
    };
  }, [socket, args.type, args.id]);

  const othersEditing = sessions.filter(s =>
    s.sessionId !== mySessionId && s.editing?.type === args.type && s.editing.id === args.id);

  return {
    othersEditing,
    remoteChange,
    keepMineVersion,
    reviewMerge: () => { setRemoteChange(null); argsRef.current.onFresh(); },
    keepMine: () => { setKeepMineVersion(remoteChange?.version ?? null); setRemoteChange(null); },
  };
}
