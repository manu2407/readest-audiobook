import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { BoxedList, SettingsRow } from './primitives';

const STORAGE_KEY = 'readest.music.settings';

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    clientId: '',
    playlistId: '',
    floor: 0.2,
    peak: 0.8,
    reactivity: 0.5,
    curve: 'easeInOut',
  };
}

function saveSettings(s: Record<string, unknown>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

const MusicSettingsPanel: React.FC = () => {
  const _ = useTranslation();
  const [stored, setStored] = useState(loadSettings);
  const [clientId, setClientId] = useState(stored.clientId);
  const [playlistId, setPlaylistId] = useState(stored.playlistId);
  const [connected, setConnected] = useState(!!stored.clientId);
  const [tracks, setTracks] = useState<number>(0);
  const [floor, setFloor] = useState(stored.floor);
  const [peak, setPeak] = useState(stored.peak);
  const [reactivity, setReactivity] = useState(stored.reactivity);
  const [curve, setCurve] = useState(stored.curve);

  const handleConnect = () => {
    saveSettings({ ...stored, clientId });
    setConnected(true);
  };

  const handleFetch = async () => {
    if (!clientId) return;
    saveSettings({ ...stored, clientId, playlistId });
    setTracks(42); // placeholder — real fetch needs OAuth token
  };

  const persist = (patch: Record<string, unknown>) => {
    const next = { ...stored, ...patch };
    setStored(next);
    saveSettings(next);
  };

  return (
    <div className='music-settings-panel'>
      <BoxedList>
        <div className='px-4 py-2 font-semibold'>{_('YouTube Music')}</div>

        <SettingsRow label={_('OAuth Client ID')}>
          <input
            className='input input-bordered w-full max-w-xs'
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder='123456789-xxx.apps.googleusercontent.com'
          />
        </SettingsRow>

        {!connected ? (
          <SettingsRow label=''>
            <button className='btn btn-primary' onClick={handleConnect}>
              {_('Connect Account')}
            </button>
          </SettingsRow>
        ) : (
          <SettingsRow label={_('Status')}>
            <span className='text-success'>{_('Connected')}</span>
          </SettingsRow>
        )}

        <SettingsRow label={_('Playlist URL or ID')}>
          <div className='flex gap-2'>
            <input
              className='input input-bordered flex-1'
              value={playlistId}
              onChange={(e) => setPlaylistId(e.target.value)}
              placeholder='https://youtube.com/playlist?list=...'
            />
            <button className='btn btn-secondary' onClick={handleFetch}>
              {_('Fetch')}
            </button>
          </div>
        </SettingsRow>

        {tracks > 0 && (
          <SettingsRow label={_('Tracks')}>
            <span>
              {tracks} {_('tracks loaded')}
            </span>
          </SettingsRow>
        )}
      </BoxedList>

      <BoxedList className='mt-4'>
        <div className='px-4 py-2 font-semibold'>{_('Ducking Controls')}</div>

        <SettingsRow label={_('Music Floor')}>
          <input
            type='range'
            min={0}
            max={100}
            value={Math.round(floor * 100)}
            onChange={(e) => {
              const v = +e.target.value / 100;
              setFloor(v);
              persist({ floor: v });
            }}
            className='range w-full max-w-xs'
          />
          <span className='ml-2 text-sm'>{Math.round(floor * 100)}%</span>
        </SettingsRow>

        <SettingsRow label={_('Peak Volume')}>
          <input
            type='range'
            min={0}
            max={100}
            value={Math.round(peak * 100)}
            onChange={(e) => {
              const v = +e.target.value / 100;
              setPeak(v);
              persist({ peak: v });
            }}
            className='range w-full max-w-xs'
          />
          <span className='ml-2 text-sm'>{Math.round(peak * 100)}%</span>
        </SettingsRow>

        <SettingsRow label={_('Reactivity')}>
          <input
            type='range'
            min={0}
            max={100}
            value={Math.round(reactivity * 100)}
            onChange={(e) => {
              const v = +e.target.value / 100;
              setReactivity(v);
              persist({ reactivity: v });
            }}
            className='range w-full max-w-xs'
          />
          <span className='ml-2 text-sm'>{Math.round(reactivity * 100)}%</span>
        </SettingsRow>

        <SettingsRow label={_('Duck Curve')}>
          <select
            className='select select-bordered w-full max-w-xs'
            value={curve}
            onChange={(e) => {
              setCurve(e.target.value);
              persist({ curve: e.target.value });
            }}
          >
            <option value='easeInOut'>{_('Ease In-Out')}</option>
            <option value='linear'>{_('Linear')}</option>
          </select>
        </SettingsRow>
      </BoxedList>
    </div>
  );
};

export default MusicSettingsPanel;
