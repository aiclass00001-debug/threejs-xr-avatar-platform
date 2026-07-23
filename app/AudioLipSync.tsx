"use client";

import { MutableRefObject, useEffect, useRef, useState } from "react";

export type LipSyncFrame = { active: boolean; level: number; aa: number; ih: number; ee: number; oh: number; ou: number };
export const emptyLipSyncFrame = (): LipSyncFrame => ({ active:false, level:0, aa:0, ih:0, ee:0, oh:0, ou:0 });

type Props = { audioUrl: string | null; fileName: string; lipSyncRef: MutableRefObject<LipSyncFrame>; onActiveChange: (active:boolean) => void; onStatus: (message:string) => void };

export default function AudioLipSync({ audioUrl, fileName, lipSyncRef, onActiveChange, onStatus }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const rafRef = useRef(0);
  const sensitivityRef = useRef(1);
  const mouthMaxRef = useRef(.48);
  const [sensitivity,setSensitivity] = useState(1);
  const [mouthMax,setMouthMax] = useState(.48);
  const [level,setLevel] = useState(0);

  const reset = () => { cancelAnimationFrame(rafRef.current); lipSyncRef.current = emptyLipSyncFrame(); setLevel(0); onActiveChange(false); };
  useEffect(() => { reset(); if (audioRef.current) { audioRef.current.pause(); audioRef.current.load(); } }, [audioUrl]);
  useEffect(() => () => { cancelAnimationFrame(rafRef.current); contextRef.current?.close(); }, []);

  const beginAnalysis = async () => {
    const audio = audioRef.current; if (!audio) return;
    if (!contextRef.current) contextRef.current = new AudioContext();
    const context = contextRef.current;
    if (!sourceRef.current) { sourceRef.current = context.createMediaElementSource(audio); analyserRef.current = context.createAnalyser(); analyserRef.current.fftSize = 512; analyserRef.current.smoothingTimeConstant = .58; sourceRef.current.connect(analyserRef.current); analyserRef.current.connect(context.destination); }
    await context.resume(); onActiveChange(true); onStatus(`LipSyncManager.play(${fileName})`);
    const analyser = analyserRef.current!; const frequency = new Uint8Array(analyser.frequencyBinCount); const time = new Uint8Array(analyser.fftSize);
    const average = (from:number,to:number) => { let sum=0; const end=Math.min(to,frequency.length); for(let i=from;i<end;i++)sum+=frequency[i]; return sum/Math.max(1,end-from)/255; };
    const update = () => {
      if (audio.paused || audio.ended) { reset(); return; }
      analyser.getByteFrequencyData(frequency); analyser.getByteTimeDomainData(time);
      let squares=0; for(const value of time){const n=(value-128)/128;squares+=n*n;} const rms=Math.sqrt(squares/time.length);
      const gate=Math.max(0,(rms-.022)*sensitivityRef.current*3.4); const low=average(2,12), mid=average(12,45), high=average(45,110);
      const cap=mouthMaxRef.current; const open=Math.min(cap,gate); const frame: LipSyncFrame = {
        active:true, level:open,
        aa:Math.min(cap,open*(.58+mid*.72)),
        ih:Math.min(cap,open*high*.72), ee:Math.min(cap,open*high*.92),
        oh:Math.min(cap,open*low*.9), ou:Math.min(cap,open*(low*.62+mid*.2)),
      };
      lipSyncRef.current=frame; setLevel(previous=>Math.abs(previous-open)>.035?open:previous); rafRef.current=requestAnimationFrame(update);
    };
    cancelAnimationFrame(rafRef.current); update();
  };

  return <div className="lip-sync-module">
    <div className="lip-title"><span>AUDIO LIP SYNC</span><b>{audioUrl?"READY":"NO AUDIO"}</b></div>
    <div className="audio-name">{audioUrl?fileName:"Import MP3 / WAV / OGG"}</div>
    <audio ref={audioRef} src={audioUrl??undefined} controls onPlay={beginAnalysis} onPause={reset} onEnded={reset}/>
    <div className="voice-meter"><i style={{width:`${Math.round(level*100)}%`}}/><span>INPUT {Math.round(level*100)}%</span></div>
    <label>SENSITIVITY <input type="range" min="0.2" max="1.8" step="0.05" value={sensitivity} onChange={event=>{const value=Number(event.target.value);setSensitivity(value);sensitivityRef.current=value;}}/><b>{sensitivity.toFixed(2)}</b></label>
    <label>MOUTH MAX <input type="range" min="0.15" max="0.85" step="0.05" value={mouthMax} onChange={event=>{const value=Number(event.target.value);setMouthMax(value);mouthMaxRef.current=value;}}/><b>{Math.round(mouthMax*100)}%</b></label>
    <small>Web Audio Analyser → A / I / U / E / O</small>
  </div>;
}
