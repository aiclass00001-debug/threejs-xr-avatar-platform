"use client";

import { MutableRefObject, useEffect, useRef, useState } from "react";
import { FaceLandmarker, FilesetResolver, HandLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import { Euler, Matrix4 } from "three";
import { Pose as KalidokitPose } from "kalidokit";

type Rotation = { x:number; y:number; z:number };
export type BodyRig = { spine:Rotation; leftUpperArm:Rotation; leftLowerArm:Rotation; rightUpperArm:Rotation; rightLowerArm:Rotation };

export type FaceFrame = {
  providerActive: boolean;
  active: boolean;
  blinkLeft: number;
  blinkRight: number;
  jawOpen: number;
  mouthFunnel: number;
  mouthPucker: number;
  smile: number;
  browUp: number;
  head: { x: number; y: number; z: number };
  poseActive: boolean;
  handsActive: boolean;
  pose: Array<{ x: number; y: number; z: number; visibility?: number }>;
  leftHand: Array<{ x: number; y: number; z: number; visibility?: number }>;
  rightHand: Array<{ x: number; y: number; z: number; visibility?: number }>;
  bodyRig: BodyRig|null;
};

export const emptyFaceFrame = (): FaceFrame => ({ providerActive: false, active: false, blinkLeft: 0, blinkRight: 0, jawOpen: 0, mouthFunnel: 0, mouthPucker: 0, smile: 0, browUp: 0, head: { x: 0, y: 0, z: 0 }, poseActive: false, handsActive: false, pose: [], leftHand: [], rightHand: [], bodyRig:null });

type Props = { trackingRef: MutableRefObject<FaceFrame>; onStatus: (message: string) => void };

export default function WebcamFaceTracker({ trackingRef, onStatus }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const poseRef = useRef<PoseLandmarker | null>(null);
  const handsRef = useRef<HandLandmarker | null>(null);
  const rafRef = useRef(0);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [faceFound, setFaceFound] = useState(false);
  const [mode, setMode] = useState<"face" | "full">("full");
  const [poseFound, setPoseFound] = useState(false);
  const [handsFound, setHandsFound] = useState(false);

  const stop = () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    landmarkerRef.current?.close();
    poseRef.current?.close(); handsRef.current?.close();
    landmarkerRef.current = null;
    poseRef.current = null; handsRef.current = null;
    trackingRef.current = emptyFaceFrame();
    setEnabled(false); setFaceFound(false); setPoseFound(false); setHandsFound(false); setLoading(false);
    onStatus("WebcamTrackingProvider.stop()");
  };

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(track => track.stop());
    landmarkerRef.current?.close();
    poseRef.current?.close(); handsRef.current?.close();
  }, []);

  const start = async () => {
    if (enabled || loading) return;
    setLoading(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("Video element is unavailable");
      video.srcObject = stream;
      await video.play();
      const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm");
      const landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task", delegate: "GPU" },
        runningMode: "VIDEO", numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: .6, minFacePresenceConfidence: .6, minTrackingConfidence: .6,
      });
      let poseLandmarker: PoseLandmarker | null = null;
      let handLandmarker: HandLandmarker | null = null;
      if (mode === "full") {
        poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task", delegate: "GPU" },
          runningMode: "VIDEO", numPoses: 1, minPoseDetectionConfidence: .55, minPosePresenceConfidence: .55, minTrackingConfidence: .55,
        });
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate: "GPU" },
          runningMode: "VIDEO", numHands: 2, minHandDetectionConfidence: .5, minHandPresenceConfidence: .5, minTrackingConfidence: .5,
        });
      }
      poseRef.current = poseLandmarker; handsRef.current = handLandmarker;
      landmarkerRef.current = landmarker; setEnabled(true); setLoading(false); onStatus("WebcamTrackingProvider.start() · MediaPipe ready");
      trackingRef.current.providerActive = true;
      let lastVideoTime = -1;
      let lastBodyTime = 0;
      const matrix = new Matrix4(); const euler = new Euler();
      const detect = () => {
        const tracker = landmarkerRef.current;
        if (!tracker || !videoRef.current) return;
        const source = videoRef.current;
        if (source.readyState >= 2 && source.currentTime !== lastVideoTime) {
          lastVideoTime = source.currentTime;
          const result = tracker.detectForVideo(source, performance.now());
          const categories = result.faceBlendshapes[0]?.categories ?? [];
          const score = (name: string) => categories.find(c => c.categoryName === name)?.score ?? 0;
          const found = categories.length > 0;
          const transform = result.facialTransformationMatrixes[0]?.data;
          const head = { x: 0, y: 0, z: 0 };
          if (transform?.length === 16) { matrix.fromArray(Array.from(transform)); euler.setFromRotationMatrix(matrix, "YXZ"); head.x = euler.x; head.y = euler.y; head.z = euler.z; }
          let pose = trackingRef.current.pose;
          let leftHand = trackingRef.current.leftHand;
          let rightHand = trackingRef.current.rightHand;
          let currentPoseFound = trackingRef.current.poseActive;
          let currentHandsFound = trackingRef.current.handsActive;
          let bodyRig=trackingRef.current.bodyRig;
          const now = performance.now();
          if (mode === "full" && now - lastBodyTime > 45) {
            lastBodyTime = now;
            const poseResult = poseRef.current?.detectForVideo(source, now);
            pose = (poseResult?.landmarks[0] ?? []).map(p => ({ x: p.x, y: p.y, z: p.z, visibility:p.visibility??1 }));
            currentPoseFound = pose.length >= 25 && [11,12,13,14,15,16,23,24].every(index=>(pose[index]?.visibility??0)>.5);
            const world=(poseResult?.worldLandmarks[0]??[]).map(p=>({x:p.x,y:p.y,z:p.z,visibility:p.visibility??1}));
            const solved=currentPoseFound&&world.length>=25?KalidokitPose.solve(world,pose,{runtime:"mediapipe",video:source,enableLegs:false}):undefined;
            bodyRig=solved?{spine:solved.Spine,leftUpperArm:solved.LeftUpperArm,leftLowerArm:solved.LeftLowerArm,rightUpperArm:solved.RightUpperArm,rightLowerArm:solved.RightLowerArm}:null;
            const handResult = handsRef.current?.detectForVideo(source, now);
            leftHand = []; rightHand = [];
            handResult?.landmarks.forEach((points, index) => {
              const mapped = points.map(p => ({ x: p.x, y: p.y, z: p.z }));
              const label = handResult.handedness[index]?.[0]?.categoryName;
              if (label === "Left") leftHand = mapped; else rightHand = mapped;
            });
            currentHandsFound = leftHand.length === 21 || rightHand.length === 21;
            setPoseFound(previous => previous === currentPoseFound ? previous : currentPoseFound);
            setHandsFound(previous => previous === currentHandsFound ? previous : currentHandsFound);
          }
          trackingRef.current = { providerActive: true, active: found, blinkLeft: score("eyeBlinkLeft"), blinkRight: score("eyeBlinkRight"), jawOpen: score("jawOpen"), mouthFunnel: score("mouthFunnel"), mouthPucker: score("mouthPucker"), smile: (score("mouthSmileLeft") + score("mouthSmileRight")) * .5, browUp: score("browInnerUp"), head, poseActive: currentPoseFound, handsActive: currentHandsFound, pose, leftHand, rightHand, bodyRig };
          setFaceFound(previous => previous === found ? previous : found);
        }
        rafRef.current = requestAnimationFrame(detect);
      };
      detect();
    } catch (error) {
      stop();
      onStatus(`Camera error: ${error instanceof Error ? error.message : "permission or model load failed"}`);
    }
  };

  return <div className={`webcam-module ${enabled ? "enabled" : ""}`}>
    <div className="tracking-mode"><button className={mode === "face" ? "active" : ""} disabled={enabled || loading} onClick={() => setMode("face")}>FACE</button><button className={mode === "full" ? "active" : ""} disabled={enabled || loading} onClick={() => setMode("full")}>FULL BODY</button></div>
    <div className="webcam-preview"><video ref={videoRef} playsInline muted /><div className="face-frame"><i /><i /><i /><i /></div><span>{faceFound ? "FACE LOCK" : enabled ? "SEARCHING" : "CAMERA OFF"}</span><div className="tracking-badges"><b className={faceFound ? "on" : ""}>FACE</b><b className={poseFound ? "on" : ""}>POSE</b><b className={handsFound ? "on" : ""}>HANDS</b></div></div>
    <button onClick={enabled ? stop : start} disabled={loading}>{loading ? `LOADING ${mode === "full" ? "3" : "1"} AI MODEL${mode === "full" ? "S" : ""}…` : enabled ? "■ STOP CAPTURE" : `◉ START ${mode === "full" ? "FULL BODY" : "FACE"} TRACKING`}</button>
    <small>{mode === "full" ? "Face + Pose + Hands → Avatar Manager" : "Face Landmarker → Expression Manager"}</small>
  </div>;
}
