"use client";

import { forwardRef, MutableRefObject, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as THREE from "three";
import type { FaceFrame } from "./WebcamFaceTracker";
import type { LipSyncFrame } from "./AudioLipSync";
import { AvatarManager } from "./core/AvatarManager";
import type { IRuntime, RuntimeId, TargetPlacementMode } from "./runtimes/IRuntime";
import { ViewerRuntime } from "./runtimes/ViewerRuntime";
import { MindARRuntime } from "./runtimes/MindARRuntime";
import { WebXRRuntime, type WebXRStatus } from "./runtimes/WebXRRuntime";

export type ThreeVrmStageHandle = {
  requestXRSession(): Promise<void>;
  resetDemo(): void;
};

type Props = {
  url: string | null;
  animationUrl: string | null;
  animationPlaying: boolean;
  animationLoop: boolean;
  manualExpression: string;
  runtimeMode: RuntimeId;
  imageTargetSrc: string | null;
  targetPlacement: TargetPlacementMode;
  faceTrackingRef: MutableRefObject<FaceFrame>;
  lipSyncRef: MutableRefObject<LipSyncFrame>;
  onLoaded: (name: string) => void;
  onAnimationLoaded: (name: string) => void;
  onTrackingStatus: (status: string) => void;
  onPlacementResolved: (placement: "screen" | "table") => void;
  onWebXRStatus: (status: WebXRStatus, detail?: string) => void;
  onError: (message: string) => void;
};

const ThreeVrmStage = forwardRef<ThreeVrmStageHandle, Props>(function ThreeVrmStage(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const [avatar] = useState(() => new AvatarManager());
  const runtimeRef = useRef<IRuntime | null>(null);
  const manualExpressionRef = useRef(props.manualExpression);
  const [loading, setLoading] = useState(false);
  const [vrmRevision, setVrmRevision] = useState(0);

  useEffect(() => { manualExpressionRef.current = props.manualExpression; }, [props.manualExpression]);
  useImperativeHandle(ref, () => ({
    requestXRSession: async () => runtimeRef.current?.requestSession(),
    resetDemo: () => {
      runtimeRef.current?.reset();
      avatar.resetDemo();
    },
  }), [avatar]);

  useEffect(() => {
    const hostElement = host.current;
    if (!hostElement) return;
    let cancelled = false;
    let frameId = 0;
    let trackingActive = props.runtimeMode !== "mindar";
    const clock = new THREE.Clock();
    const runtime: IRuntime = props.runtimeMode === "mindar" && props.imageTargetSrc
      ? new MindARRuntime(props.imageTargetSrc, status => {
        if (status === "found") {
          trackingActive = true;
          runtime.root.updateWorldMatrix(true, true);
          avatar.resetSecondaryMotion();
        } else {
          // The hidden MindAR anchor has a zero matrix. Pausing Avatar.update
          // here prevents SpringBone from receiving invalid world transforms.
          trackingActive = false;
        }
        props.onTrackingStatus(`MindAR: ${status}`);
      }, props.targetPlacement, props.onPlacementResolved)
      : props.runtimeMode === "webxr"
        ? new WebXRRuntime((status, detail) => {
          if (status === "placed") avatar.resetSecondaryMotion();
          props.onWebXRStatus(status, detail);
        }, delta => avatar.update(delta, props.faceTrackingRef.current, props.lipSyncRef.current, manualExpressionRef.current))
        : new ViewerRuntime();
    avatar.setTrackingMotionGuard(runtime.id !== "viewer");
    runtimeRef.current = runtime;
    const start = async () => {
      try {
        await runtime.start(hostElement);
        if (cancelled) return;
        avatar.attach(runtime.root);
        if (runtime.id !== "webxr") {
          const update = () => {
            frameId = requestAnimationFrame(update);
            const delta = Math.min(clock.getDelta(), .05);
            if (trackingActive) avatar.update(delta, props.faceTrackingRef.current, props.lipSyncRef.current, manualExpressionRef.current);
            runtime.update(delta);
          };
          update();
        }
      } catch (error) {
        props.onError(error instanceof Error ? error.message : "Runtime start failed");
      }
    };
    void start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
      avatar.detach();
      avatar.setTrackingMotionGuard(false);
      void runtime.stop().finally(() => runtime.dispose());
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [avatar, props.runtimeMode, props.imageTargetSrc, props.targetPlacement, props.faceTrackingRef, props.lipSyncRef, props.onError, props.onTrackingStatus, props.onPlacementResolved, props.onWebXRStatus]);

  useEffect(() => {
    if (!props.url) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setLoading(true); });
    avatar.load(props.url).then(name => {
      if (cancelled) return;
      if (runtimeRef.current) avatar.attach(runtimeRef.current.root);
      setVrmRevision(value => value + 1);
      props.onLoaded(name);
    }).catch(error => { if (!cancelled && !String(error).includes("superseded")) props.onError(error instanceof Error ? error.message : "VRM load failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [avatar, props.url, props.onLoaded, props.onError]);

  useEffect(() => {
    if (!props.animationUrl || !avatar.ready) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setLoading(true); });
    avatar.loadAnimation(props.animationUrl, props.animationLoop, props.animationPlaying)
      .then(name => { if (!cancelled) props.onAnimationLoaded(name); })
      .catch(error => { if (!cancelled) props.onError(error instanceof Error ? error.message : "Animation load failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [avatar, props.animationUrl, vrmRevision, props.onAnimationLoaded, props.onError]);

  useEffect(() => { avatar.setAnimationState(props.animationPlaying, props.animationLoop); }, [avatar, props.animationPlaying, props.animationLoop]);
  useEffect(() => () => avatar.dispose(), [avatar]);

  return <div ref={host} className={`three-stage runtime-${props.runtimeMode}`} aria-label="Three.js XR avatar stage">
    {loading && <div className="vrm-loading"><i /><b>LOADING AVATAR CORE</b><span>One VRM instance · shared animation · shared expression</span></div>}
  </div>;
});

export default ThreeVrmStage;
