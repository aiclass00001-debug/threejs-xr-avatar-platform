"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import ThreeVrmStage, { type ThreeVrmStageHandle } from "./ThreeVrmStage";
import WebcamFaceTracker, { emptyFaceFrame, FaceFrame } from "./WebcamFaceTracker";
import AudioLipSync, { emptyLipSyncFrame, LipSyncFrame } from "./AudioLipSync";
import type { MultipartPart, ProjectAssetSlot, PublishedAsset, PublishedProject, UploadAssetInput, UploadSession } from "./projectTypes";
import type { TargetPlacementMode } from "./runtimes/IRuntime";
import type { WebXRStatus } from "./runtimes/WebXRRuntime";

type RuntimeId = "viewer" | "mindar" | "webxr";
type AssetKind = "VRM" | "Motion" | "Audio" | "Target" | "Project";

const runtimeInfo: Record<RuntimeId, { label: string; code: string; color: string; detail: string }> = {
  viewer: { label: "VIEWER", code: "RT-01", color: "#ff39c6", detail: "Orbit camera · Studio environment" },
  mindar: { label: "MINDAR", code: "RT-02", color: "#ff45ca", detail: "Image / face anchor · WebAR" },
  webxr: { label: "WEBXR", code: "RT-03", color: "#18e4ff", detail: "Hit test · Quest 3 · Hands" },
};

const defaults = [
  { kind: "VRM" as AssetKind, name: "Astra.vrm", meta: "42.8 MB", active: true },
  { kind: "Motion" as AssetKind, name: "idle_loop.fbx", meta: "8.4 s", active: false },
  { kind: "Motion" as AssetKind, name: "talk_01.vrma", meta: "12.1 s", active: false },
  { kind: "Audio" as AssetKind, name: "voice_sample.wav", meta: "00:18", active: false },
  { kind: "Target" as AssetKind, name: "marker_neon.jpg", meta: "0.92 score", active: false },
];

const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;

async function readApiJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: (T & { error?: string }) | null = null;
  try {
    body = text ? JSON.parse(text) as T & { error?: string } : null;
  } catch {
    // The hosting edge may return a plain-text/HTML 413 before the API runs.
  }
  if (!response.ok) {
    const fallback = response.status === 413
      ? "單次上傳資料仍超過網站入口限制，請重新整理後再試。"
      : `伺服器回傳 HTTP ${response.status}${text ? `：${text.slice(0, 160)}` : ""}`;
    throw new Error(body?.error || fallback);
  }
  if (!body) throw new Error("伺服器沒有回傳有效的專案資料。");
  return body;
}

async function compileMindTarget(file: File, onProgress: (percent: number) => void) {
  const bitmap = await createImageBitmap(file);
  try {
    const { Compiler } = await import("mind-ar/src/image-target/compiler.js");
    const compiler = new Compiler();
    await compiler.compileImageTargets([bitmap], onProgress);
    const data = compiler.exportData();
    const baseName = file.name.replace(/\.[^.]+$/, "") || "target";
    return new File([data], `${baseName}.mind`, { type: "application/octet-stream" });
  } finally {
    bitmap.close();
  }
}

async function materializePublishedAsset(asset: PublishedAsset, onUrl: (url: string) => void) {
  if (!asset.chunks?.length) return asset.url;
  const blobs: Blob[] = [];
  for (const chunk of asset.chunks) {
    const response = await fetch(chunk.url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`${asset.originalName} chunk ${chunk.partNumber} download failed.`);
    blobs.push(await response.blob());
  }
  const url = URL.createObjectURL(new Blob(blobs, { type: asset.contentType }));
  onUrl(url);
  return url;
}

function StageAvatar({ speaking, expression, runtime }: { speaking: boolean; expression: string; runtime: RuntimeId }) {
  return (
    <div className={`avatar ${speaking ? "is-speaking" : ""}`} data-expression={expression}>
      <div className="scan-orbit orbit-a" />
      <div className="scan-orbit orbit-b" />
      <div className="avatar-shadow" />
      <div className="avatar-body">
        <div className="avatar-head">
          <i className="ear left" /><i className="ear right" />
          <div className="hair"><span /><span /><span /></div>
          <div className="face">
            <div className="eyes"><i /><i /></div>
            <div className="mouth" />
          </div>
        </div>
        <div className="neck" />
        <div className="torso"><div className="core-light" /><span className="seam s1" /><span className="seam s2" /></div>
        <div className="arm left" /><div className="arm right" />
      </div>
      <div className="tracking-tag">{runtime === "viewer" ? "ORIGIN" : runtime === "mindar" ? "ANCHOR_01" : "HIT_TEST"}</div>
    </div>
  );
}

export default function Home() {
  const [runtime, setRuntime] = useState<RuntimeId>("viewer");
  const [transition, setTransition] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [speaking, setSpeaking] = useState(false);
  const [expression, setExpression] = useState("Neutral");
  const [assetFilter, setAssetFilter] = useState("All");
  const [assets, setAssets] = useState(defaults);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [tab, setTab] = useState<"Motion" | "Expression" | "Lip Sync">("Motion");
  const [logs, setLogs] = useState(["AvatarManager.attach(stage)", "AnimationMixer → shared", "Runtime viewer started"]);
  const [vrmUrl, setVrmUrl] = useState<string | null>(null);
  const [animationUrl, setAnimationUrl] = useState<string | null>(null);
  const [animationName, setAnimationName] = useState("No motion loaded");
  const [animationLoop, setAnimationLoop] = useState(true);
  const [audioUrl,setAudioUrl] = useState<string|null>(null);
  const [audioName,setAudioName] = useState("No audio loaded");
  const [targetDataUrl, setTargetDataUrl] = useState<string | null>(null);
  const [arRequested, setArRequested] = useState(false);
  const [arStatus, setArStatus] = useState("READY");
  const [xrStatus, setXrStatus] = useState<WebXRStatus>("checking");
  const [xrDetail, setXrDetail] = useState("Checking immersive AR support…");
  const [targetPlacement, setTargetPlacement] = useState<TargetPlacementMode>("auto");
  const [resolvedPlacement, setResolvedPlacement] = useState<"screen" | "table">("screen");
  const [runtimeError, setRuntimeError] = useState("");
  const [sharedMode, setSharedMode] = useState(false);
  const [sharedProjectName, setSharedProjectName] = useState("NEON_WITNESS_01");
  const [sharedLoading, setSharedLoading] = useState(false);
  const [shareError, setShareError] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [publishProgress, setPublishProgress] = useState("");
  const [publishedUrl, setPublishedUrl] = useState("");
  const [qrCodeUrl, setQrCodeUrl] = useState("");
  const [launchCode, setLaunchCode] = useState("");
  const [launchInput, setLaunchInput] = useState("");
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchLoading, setLaunchLoading] = useState(false);
  const [launchError, setLaunchError] = useState("");
  const [demoResetSignal, setDemoResetSignal] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<ThreeVrmStageHandle>(null);
  const publishFilesRef = useRef<Partial<Record<ProjectAssetSlot, File>>>({});
  const faceTrackingRef = useRef<FaceFrame>(emptyFaceFrame());
  const lipSyncRef = useRef<LipSyncFrame>(emptyLipSyncFrame());

  const filtered = useMemo(() => assetFilter === "All" ? assets : assets.filter(a => a.kind === assetFilter), [assets, assetFilter]);
  const handleVrmLoaded = useCallback((name: string) => setLogs(l => [`Avatar ready: ${name}`, "SpringBone / LookAt update enabled", ...l].slice(0, 5)), []);
  const handleVrmError = useCallback((message: string) => setLogs(l => [`VRM error: ${message}`, ...l].slice(0, 5)), []);
  const handleAnimationLoaded = useCallback((name: string) => { setAnimationName(name); setPlaying(true); setTab("Motion"); setLogs(l => [`AnimationMixer.play(${name})`, "Mixamo → VRM retarget complete", ...l].slice(0, 5)); }, []);
  const handleTrackingStatus = useCallback((message: string) => setLogs(l => [message, ...l].slice(0, 5)), []);
  const handleArTrackingStatus = useCallback((status: string) => {
    setArStatus(status.replace("MindAR: ", "").toUpperCase());
    handleTrackingStatus(status);
  }, [handleTrackingStatus]);
  const handlePlacementResolved = useCallback((placement: "screen" | "table") => {
    setResolvedPlacement(placement);
    setLogs(l => [`Target placement → ${placement.toUpperCase()}`, ...l].slice(0, 5));
  }, []);
  const handleWebXRStatus = useCallback((status: WebXRStatus, detail?: string) => {
    setXrStatus(status);
    setXrDetail(detail || (status === "ready" ? "Hit Test · Floor Placement · Quest Controller · Hands" : status === "unsupported" ? "此瀏覽器或裝置不支援 WebXR immersive-ar。" : status === "placed" ? "Avatar anchored to the detected floor." : ""));
    setLogs(l => [`WebXR → ${status.toUpperCase()}`, ...l].slice(0, 5));
  }, []);
  const handleStageError = useCallback((message: string) => {
    setRuntimeError(message);
    handleVrmError(message);
  }, [handleVrmError]);

  useEffect(() => {
    if (!speaking) return;
    const t = setTimeout(() => setSpeaking(false), 3600);
    return () => clearTimeout(t);
  }, [speaking]);

  useEffect(() => {
    let cancelled = false;
    const materializedUrls: string[] = [];
    const params = new URLSearchParams(window.location.search);
    const projectId = params.get("project");
    if (!projectId) {
      if (params.get("mode") === "quest" || params.get("launch") === "1") queueMicrotask(() => setLaunchOpen(true));
      return;
    }

    const loadSharedProject = async () => {
      setSharedMode(true);
      setSharedLoading(true);
      setLogs(l => [`ProjectLoader.fetch(${projectId.slice(0, 8)}…)`, ...l].slice(0, 5));
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}`);
        const body = await response.json() as PublishedProject & { error?: string };
        if (!response.ok) throw new Error(body.error || "Shared project could not be loaded.");
        const project = body;
        const { vrm, animation, audio, target, targetData } = project.assets;
        if (!vrm) throw new Error("This shared project has no VRM asset.");
        const registerUrl = (url: string) => materializedUrls.push(url);
        const resolvedVrmUrl = await materializePublishedAsset(vrm, registerUrl);
        const resolvedAnimationUrl = animation ? await materializePublishedAsset(animation, registerUrl) : null;
        const resolvedAudioUrl = audio ? await materializePublishedAsset(audio, registerUrl) : null;
        const resolvedTargetDataUrl = targetData ? await materializePublishedAsset(targetData, registerUrl) : null;
        if (cancelled) return;
        setSharedProjectName(project.name);
        setLaunchCode(project.launchCode ?? "");
        setVrmUrl(resolvedVrmUrl);
        setAnimationUrl(resolvedAnimationUrl);
        setAnimationName(animation?.originalName ?? "No motion loaded");
        setAudioUrl(resolvedAudioUrl);
        setAudioName(audio?.originalName ?? "No audio loaded");
        setTargetDataUrl(resolvedTargetDataUrl);
        setAssets(([
          vrm && { kind: "VRM", name: vrm.originalName, meta: `${(vrm.size / 1048576).toFixed(1)} MB`, active: true },
          animation && { kind: "Motion", name: animation.originalName, meta: `${(animation.size / 1048576).toFixed(1)} MB`, active: false },
          audio && { kind: "Audio", name: audio.originalName, meta: `${(audio.size / 1048576).toFixed(1)} MB`, active: false },
          target && { kind: "Target", name: target.originalName, meta: `${(target.size / 1048576).toFixed(1)} MB`, active: false },
        ].filter(Boolean)) as typeof defaults);
        setLogs(l => ["Shared project ready · single VRM instance", ...l].slice(0, 5));
      } catch (error) {
        if (!cancelled) setShareError(error instanceof Error ? error.message : "Shared project could not be loaded.");
      } finally {
        if (!cancelled) setSharedLoading(false);
      }
    };
    void loadSharedProject();
    return () => {
      cancelled = true;
      materializedUrls.forEach(url => URL.revokeObjectURL(url));
    };
  }, []);

  const switchRuntime = (next: RuntimeId) => {
    if (next === runtime || transition) return;
    setTransition(true);
    const old = runtime;
    setLogs(l => [`${runtimeInfo[old].label} → stop / dispose`, "AvatarManager.detach()", ...l].slice(0, 5));
    setTimeout(() => {
      setRuntime(next);
      setLogs(l => [`${runtimeInfo[next].label} → start`, "AvatarManager.attach(runtime.root)", "VRM instance retained: #A-001", ...l].slice(0, 5));
      setTransition(false);
    }, 620);
  };

  const startArCamera = async () => {
    if (targetPlacement === "auto") {
      const orientation = window.DeviceOrientationEvent as typeof DeviceOrientationEvent & {
        requestPermission?: () => Promise<"granted" | "denied">;
      };
      try {
        if (typeof orientation?.requestPermission === "function") await orientation.requestPermission();
      } catch {
        // AUTO safely falls back to SCREEN; TABLE remains manually selectable.
      }
    }
    setRuntimeError("");
    setArRequested(true);
    setArStatus("STARTING");
    switchRuntime("mindar");
  };

  const prepareWebXR = () => {
    setRuntimeError("");
    setArRequested(true);
    setXrStatus("checking");
    setXrDetail("Checking immersive AR support…");
    switchRuntime("webxr");
  };

  const enterWebXR = async () => {
    setXrStatus("starting");
    setXrDetail("Requesting immersive AR session…");
    await stageRef.current?.requestXRSession();
  };

  const resetDemo = () => {
    stageRef.current?.resetDemo();
    setPlaying(true);
    setExpression("Neutral");
    setSpeaking(false);
    lipSyncRef.current = emptyLipSyncFrame();
    setDemoResetSignal(value => value + 1);
    setRuntimeError("");
    if (runtime === "mindar") setArStatus("SCANNING");
    setLogs(l => ["RESET DEMO · avatar and audio restored", "AvatarManager.resetDemo()", ...l].slice(0, 5));
  };

  const resolveLaunchCode = async () => {
    const compact = launchInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const normalized = compact.startsWith("XR") ? `XR-${compact.slice(2)}` : `XR-${compact}`;
    if (!/^XR-[A-Z0-9]{6}$/.test(normalized)) {
      setLaunchError("請輸入 XR- 加六位英數字，例如 XR-A7K29Q。");
      return;
    }
    setLaunchLoading(true);
    setLaunchError("");
    try {
      const response = await fetch(`/api/launch/${encodeURIComponent(normalized)}`, { cache: "no-store" });
      const body = await response.json() as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error || "Launch Code 無法載入。");
      window.location.assign(body.url);
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : "Launch Code 無法載入。");
      setLaunchLoading(false);
    }
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    const vrmFile = files.find(file => file.name.toLowerCase().endsWith(".vrm"));
    if (vrmFile) {
      publishFilesRef.current.vrm = vrmFile;
      if (vrmUrl) URL.revokeObjectURL(vrmUrl);
      setVrmUrl(URL.createObjectURL(vrmFile));
      setLogs(l => [`VRMLoader.load(${vrmFile.name})`, ...l].slice(0, 5));
    }
    const fbxFile = files.find(file => file.name.toLowerCase().endsWith(".fbx"));
    if (fbxFile) {
      publishFilesRef.current.animation = fbxFile;
      if (animationUrl) URL.revokeObjectURL(animationUrl);
      setAnimationUrl(URL.createObjectURL(fbxFile)); setAnimationName(fbxFile.name); setPlaying(true); setTab("Motion");
      setLogs(l => [`FBXLoader.load(${fbxFile.name})`, ...l].slice(0, 5));
    }
    const audioFile=files.find(file=>/\.(mp3|wav|ogg|m4a)$/i.test(file.name));
    if(audioFile){publishFilesRef.current.audio=audioFile;if(audioUrl)URL.revokeObjectURL(audioUrl);setAudioUrl(URL.createObjectURL(audioFile));setAudioName(audioFile.name);setTab("Lip Sync");setLogs(l=>[`AudioManager.load(${audioFile.name})`,...l].slice(0,5));}
    const targetFile=files.find(file=>/\.(jpg|jpeg|png|webp)$/i.test(file.name));
    if(targetFile){publishFilesRef.current.target=targetFile;delete publishFilesRef.current.targetData;}
    const vrmaFile=files.find(file=>file.name.toLowerCase().endsWith(".vrma"));
    if(!fbxFile&&vrmaFile) publishFilesRef.current.animation=vrmaFile;
    setAssets(current => [...files.map(file => {
      const ext = file.name.split(".").pop()?.toLowerCase();
      const kind: AssetKind = ext === "vrm" ? "VRM" : ["mp3", "wav", "ogg", "m4a"].includes(ext || "") ? "Audio" : ["jpg", "jpeg", "png", "webp"].includes(ext || "") ? "Target" : "Motion";
      return { kind, name: file.name, meta: `${(file.size / 1048576).toFixed(1)} MB`, active: false };
    }), ...current]);
    setLogs(l => [`AssetManager.ingest(${files.length})`, ...l].slice(0, 5));
    event.target.value = "";
  };

  const publishProject = async () => {
    const files = publishFilesRef.current;
    if (!files.vrm) {
      setShareError("請先 IMPORT 一個 VRM；範例清單不是實際可發佈的檔案。");
      return;
    }
    setPublishing(true);
    setPublishProgress("PREPARING…");
    setShareError("");
    try {
      if (files.target && !files.targetData) {
        setPublishProgress("COMPILING TARGET 0%");
        files.targetData = await compileMindTarget(files.target, percent => {
          setPublishProgress(`COMPILING TARGET ${Math.round(percent)}%`);
        });
      }
      const entries = (Object.keys(files) as ProjectAssetSlot[])
        .map(slot => ({ slot, file: files[slot] }))
        .filter((entry): entry is { slot: ProjectAssetSlot; file: File } => Boolean(entry.file));
      const metadata = Object.fromEntries(entries.map(({ slot, file }) => [slot, {
        originalName: file.name,
        contentType: file.type,
        size: file.size,
      } satisfies UploadAssetInput])) as Partial<Record<ProjectAssetSlot, UploadAssetInput>>;

      const initResponse = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "NEON_WITNESS_01", assets: metadata }),
      });
      const init = await readApiJson<{
        projectId: string;
        name: string;
        uploads: Partial<Record<ProjectAssetSlot, UploadAssetInput & { name: string; uploadId: string }>>;
      }>(initResponse);

      const totalBytes = entries.reduce((sum, entry) => sum + entry.file.size, 0);
      let uploadedBytes = 0;
      const completedUploads: Partial<Record<ProjectAssetSlot, UploadSession>> = {};

      for (const { slot, file } of entries) {
        const session = init.uploads[slot];
        if (!session) throw new Error(`${slot} 上傳工作階段建立失敗。`);
        const parts: MultipartPart[] = [];
        const partCount = Math.ceil(file.size / UPLOAD_CHUNK_SIZE);
        for (let index = 0; index < partCount; index += 1) {
          const chunk = file.slice(index * UPLOAD_CHUNK_SIZE, Math.min(file.size, (index + 1) * UPLOAD_CHUNK_SIZE));
          const query = new URLSearchParams({
            slot,
            name: session.name,
            uploadId: session.uploadId,
            part: String(index + 1),
          });
          const partResponse = await fetch(`/api/projects/${init.projectId}/upload?${query}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: chunk,
          });
          const partBody = await readApiJson<{ part: MultipartPart }>(partResponse);
          parts.push(partBody.part);
          uploadedBytes += chunk.size;
          setPublishProgress(`UPLOADING ${Math.min(99, Math.round(uploadedBytes / totalBytes * 100))}%`);
        }
        completedUploads[slot] = { ...session, parts };
      }

      setPublishProgress("FINALIZING…");
      const completeResponse = await fetch(`/api/projects/${init.projectId}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: init.name, uploads: completedUploads }),
      });
      const completed = await readApiJson<{ project: PublishedProject }>(completeResponse);
      const url = `${window.location.origin}/?project=${completed.project.id}&mode=mobile`;
      setPublishedUrl(url);
      setLaunchCode(completed.project.launchCode ?? "");
      setQrCodeUrl(await QRCode.toDataURL(url, {
        width: 220,
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#090a19", light: "#ffffff" },
      }));
      setLogs(l => [`Project published: ${completed.project.id.slice(0, 8)}…`, "QR launch URL generated", ...l].slice(0, 5));
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "Project publish failed.");
    } finally {
      setPublishing(false);
      setPublishProgress("");
    }
  };

  return (
    <main className={`app-shell ${sharedMode ? "shared-runtime" : ""}`} style={{ "--runtime": runtimeInfo[runtime].color } as React.CSSProperties}>
      <header className="topbar">
        <div className="brand-mark"><span>XR</span></div>
        <div className="brand"><strong>XR AVATAR STUDIO</strong><small>THREE.JS · VRM · WEBXR</small></div>
        <div className="project-name"><span>{sharedMode ? "SHARED PROJECT" : "PROJECT"}</span><b>{sharedProjectName}</b></div>
        <div className="core-status"><i /> CORE ONLINE <em>60 FPS</em></div>
        {!sharedMode && <button className="quest-code-btn" onClick={() => { setLaunchError(""); setLaunchOpen(true); }}>QUEST CODE</button>}
        {!sharedMode && <button className="export-btn" onClick={publishProject} disabled={publishing}>{publishing ? publishProgress || "PUBLISHING…" : "PUBLISH AR PROJECT"} <span>↗</span></button>}
        {sharedMode && <div className="mobile-project-badge">{launchCode || "MOBILE PROJECT"}</div>}
      </header>

      <section className="runtime-rail" aria-label="Runtime selector">
        <div className="rail-label">RUNTIME LAYER</div>
        {(Object.keys(runtimeInfo) as RuntimeId[]).map(id => (
          <button key={id} className={runtime === id ? "active" : ""} onClick={() => switchRuntime(id)}>
            <span className="runtime-code">{runtimeInfo[id].code}</span>
            <b>{runtimeInfo[id].label}</b>
            <small>{runtimeInfo[id].detail}</small>
            <i className="runtime-led" />
          </button>
        ))}
        <div className="rail-flow"><span>STOP</span><i /><span>DETACH</span><i /><span>ATTACH</span><i /><span>START</span></div>
      </section>

      <section className="workspace">
        <aside className="asset-panel panel">
          <div className="panel-title"><div><span>01</span><b>CHARACTER &amp; ASSETS</b></div>{!sharedMode && <button onClick={() => fileRef.current?.click()}>＋ IMPORT</button>}</div>
          <input ref={fileRef} type="file" multiple accept=".vrm,.vrma,.fbx,.glb,.gltf,.wav,.mp3,.ogg,.m4a,.jpg,.jpeg,.png,.webp" onChange={upload} hidden />
          <div className="asset-tabs">
            {["All", "VRM", "Motion", "Audio", "Target"].map(kind => <button key={kind} onClick={() => setAssetFilter(kind)} className={assetFilter === kind ? "active" : ""}>{kind}</button>)}
          </div>
          <div className="asset-list">
            {filtered.map((asset, index) => (
              <button className={`asset-row ${asset.active ? "selected" : ""}`} key={`${asset.name}-${index}`} onClick={() => setAssets(a => a.map(x => ({ ...x, active: x.name === asset.name })))}>
                <span className={`asset-icon k-${asset.kind.toLowerCase()}`}>{asset.kind.slice(0, 2).toUpperCase()}</span>
                <span><b>{asset.name}</b><small>{asset.kind} · {asset.meta}</small></span><i>⋮</i>
              </button>
            ))}
          </div>
          {!sharedMode && <div className="drop-zone" onClick={() => fileRef.current?.click()}><b>DROP ASSETS</b><span>VRM · VRMA · FBX · AUDIO · TARGET</span></div>}
        </aside>

        <div className="stage panel">
          <div className="stage-topline">
            <span>SCENE / AVATAR_STAGE</span><span>CAMERA_01</span><b>{runtimeInfo[runtime].label} ACTIVE</b>
          </div>
          <div className="grid-floor" />
          <div className="vertical-axis" />
          {vrmUrl ? <ThreeVrmStage ref={stageRef} url={vrmUrl} animationUrl={animationUrl} animationPlaying={playing} animationLoop={animationLoop} manualExpression={expression} runtimeMode={runtime} imageTargetSrc={targetDataUrl} targetPlacement={targetPlacement} faceTrackingRef={faceTrackingRef} lipSyncRef={lipSyncRef} onLoaded={handleVrmLoaded} onAnimationLoaded={handleAnimationLoaded} onTrackingStatus={handleArTrackingStatus} onPlacementResolved={handlePlacementResolved} onWebXRStatus={handleWebXRStatus} onError={handleStageError} /> : <StageAvatar speaking={speaking} expression={expression} runtime={runtime} />}
          {transition && <div className="runtime-transition"><i /><b>SWITCHING RUNTIME</b><span>Single avatar instance retained</span></div>}
          {sharedLoading && <div className="runtime-transition"><i /><b>LOADING SHARED PROJECT</b><span>Fetching VRM assets from project storage</span></div>}
          {sharedMode && targetDataUrl && !arRequested && !sharedLoading && <div className="ar-launch">
            <span>MINDAR IMAGE TRACKING</span><h2>將角色放到圖片上</h2><p>按下後允許相機權限，再將鏡頭對準你發佈專案時使用的 Target Image。</p>
            <div className="placement-picker" aria-label="Target placement">
              {(["auto", "screen", "table"] as TargetPlacementMode[]).map(mode => <button key={mode} className={targetPlacement === mode ? "active" : ""} onClick={() => setTargetPlacement(mode)}><b>{mode.toUpperCase()}</b><small>{mode === "auto" ? "重力感測" : mode === "screen" ? "螢幕 / 牆面" : "桌面平放"}</small></button>)}
            </div>
            <button className="ar-start" onClick={startArCamera}>START AR CAMERA</button>
            <button className="webxr-choice" onClick={prepareWebXR}>USE WEBXR FLOOR PLACEMENT</button>
          </div>}
          {sharedMode && !targetDataUrl && !sharedLoading && !arRequested && <div className="ar-missing-target"><b>WEBXR FLOOR PLACEMENT</b><span>此專案沒有 Target Image，仍可使用 WebXR 放置角色。</span><button onClick={prepareWebXR}>PREPARE WEBXR</button></div>}
          {sharedMode && arRequested && runtime === "mindar" && <div className={`ar-status is-${arStatus.toLowerCase()}`}><i />{arStatus === "FOUND" ? "TARGET FOUND" : arStatus === "LOST" ? "TARGET LOST · SCANNING" : arStatus}</div>}
          {sharedMode && arRequested && runtime === "mindar" && <div className="ar-placement">{targetPlacement.toUpperCase()}{targetPlacement === "auto" ? ` → ${resolvedPlacement.toUpperCase()}` : ""}</div>}
          {runtime === "webxr" && !["starting", "scanning", "placed"].includes(xrStatus) && <div className="xr-launch">
            <span>THREE.JS WEBXR RUNTIME</span><h2>在真實地面放置角色</h2><p>{xrDetail}</p>
            <div className="xr-capabilities"><b>HIT TEST</b><b>FLOOR</b><b>QUEST 3</b><b>HANDS</b></div>
            <button onClick={enterWebXR} disabled={xrStatus !== "ready"}>{xrStatus === "unsupported" ? "WEBXR NOT SUPPORTED" : xrStatus === "checking" ? "CHECKING SUPPORT…" : "ENTER IMMERSIVE AR"}</button>
          </div>}
          {runtime === "webxr" && ["starting", "scanning"].includes(xrStatus) && <div className="xr-scan"><i /><b>{xrStatus === "starting" ? "STARTING WEBXR" : "SCAN THE FLOOR"}</b><span>{xrDetail || "移動裝置，準星出現後點擊畫面或按下 Controller。"}</span></div>}
          {runtime === "webxr" && xrStatus === "placed" && <div className="xr-live"><i />PINCH / TRIGGER TO MOVE · TWO HANDS ROTATE + SCALE</div>}
          {sharedMode && arRequested && runtimeError && <div className="ar-runtime-error"><b>AR START ERROR</b><span>{runtimeError}</span></div>}
          {sharedMode && arRequested && <button className="reset-demo" onClick={resetDemo}>↺ RESET DEMO</button>}
          {sharedMode && arRequested && <button className="ar-stop" onClick={() => { setArRequested(false); setArStatus("READY"); switchRuntime("viewer"); }}>EXIT XR</button>}
          {sharedMode && shareError && <div className="shared-load-error"><b>PROJECT LOAD ERROR</b><span>{shareError}</span></div>}
          <div className="stage-tools"><button>⌖</button><button>↻</button><button>⊞</button><button>◫</button></div>
          <div className="hud hud-left"><span>AVATAR INSTANCE</span><b>#A-001 / SINGLETON</b><small>SpringBone ✓ · LookAt ✓</small></div>
          <div className="hud hud-right"><span>TRACKING</span><b>{runtime === "viewer" ? "LOCAL ORIGIN" : runtime === "mindar" ? "IMAGE ANCHOR" : "XR SESSION"}</b><small>{runtime === "webxr" ? "Quest 3 ready" : runtime === "mindar" ? "Camera permission required" : "OrbitControls enabled"}</small></div>
          <div className="stage-bottom"><span>X 0.00</span><span>Y 0.00</span><span>Z 0.00</span><em>1 UNIT = 1 METER</em></div>
        </div>

        <aside className="inspector panel">
          <div className="inspector-tabs"><button className="active">EXPRESSION</button><button onClick={() => setTab("Lip Sync")}>LIP SYNC</button></div>
          <div className="panel-title"><div><span>02</span><b>AVATAR CORE</b></div><i className="live-dot" /></div>
          <div className="avatar-id"><span className="mini-avatar">A</span><div><b>Astra.vrm</b><small>VRM 1.0 · Humanoid</small></div><em>READY</em></div>
          <div className="expression-presets">
            <span>EXPRESSION PRESETS</span>
            <div>{["Neutral", "Happy", "Angry", "Sad", "Surprised"].map(item => <button key={item} className={expression === item ? "active" : ""} onClick={() => { setExpression(item); setTab("Expression"); setLogs(l => [`ExpressionManager.set(${item})`, ...l].slice(0, 5)); }}><i>{item === "Neutral" ? "•ᴗ•" : item === "Happy" ? "＾▽＾" : item === "Angry" ? "`皿´" : item === "Sad" ? "╥﹏╥" : "⊙o⊙"}</i><b>{item}</b></button>)}</div>
            <small>Manual control is active when webcam tracking is off.</small>
          </div>
          <WebcamFaceTracker trackingRef={faceTrackingRef} onStatus={handleTrackingStatus} />
          <AudioLipSync key={`${audioUrl ?? "none"}-${demoResetSignal}`} audioUrl={audioUrl} fileName={audioName} lipSyncRef={lipSyncRef} onActiveChange={setSpeaking} onStatus={handleTrackingStatus}/>
          <div className="core-stack">
            {["VRM Loader", "Animation Mixer", "Expression", "SpringBone", "LookAt", "Lip Sync"].map((item, i) => <div key={item}><i className={i < 5 || speaking ? "on" : ""} /><span>{item}</span><b>{i < 5 ? "SHARED" : speaking ? "LIVE" : "IDLE"}</b></div>)}
          </div>
          <div className="inspector-section"><h3>RUNTIME CONTRACT</h3><code>attach(root)<br />detach()<br />update(delta)</code></div>
          <div className="inspector-section"><h3>DEPENDENCY GRAPH</h3><div className="dependency"><b>IRuntime</b><span>→</span><b>Three.js Core</b><span>→</span><b>AvatarManager</b></div></div>
          <div className="memory"><span>VRM INSTANCES</span><b>01</b><small>64.2 MB GPU</small></div>
        </aside>
      </section>

      <section className="timeline panel">
        <div className="timeline-tabs">
          {(["Motion", "Expression", "Lip Sync"] as const).map(t => <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>)}
        </div>
        <button className="transport" onClick={() => setPlaying(!playing)}>{playing ? "Ⅱ" : "▶"}</button>
        <div className="timecode">00:00:{playing ? "06:18" : "00:00"}</div>
        <div className="track-area"><div className="track-label"><b>{tab === "Motion" ? animationName : tab === "Expression" ? expression.toLowerCase() : "voice_sample"}</b><span>{tab === "Lip Sync" ? "VISEME TRACK" : "SHARED MIXER"}</span></div><div className="track"><i className={playing ? "playing" : ""} /><span className="clip">{tab === "Motion" ? (animationUrl ? "MIXAMO / RETARGETED" : "IMPORT MIXAMO FBX") : tab === "Expression" ? "EXPRESSION BLEND" : "A · E · I · O · U"}</span></div></div>
        <div className="quick-controls">
          <select value={expression} onChange={e => setExpression(e.target.value)} aria-label="Expression"><option>Neutral</option><option>Happy</option><option>Angry</option><option>Sad</option><option>Surprised</option></select>
          <button className={animationLoop ? "active" : ""} onClick={() => setAnimationLoop(value => !value)}>{animationLoop ? "LOOP ON" : "LOOP OFF"}</button>
          <button onClick={() => { setSpeaking(true); setTab("Lip Sync"); setLogs(l => ["LipSyncManager.play(voice_sample)", ...l].slice(0, 5)); }}>TEST VOICE</button>
        </div>
      </section>

      <section className={`console panel ${consoleOpen ? "" : "closed"}`}>
        <button className="console-toggle" onClick={() => setConsoleOpen(!consoleOpen)}><span>03</span> EVENT STREAM <i>{consoleOpen ? "−" : "+"}</i></button>
        {consoleOpen && <div className="log-list">{logs.map((log, i) => <span key={`${log}-${i}`}><em>{`T+${(i * 0.423).toFixed(3)}s`}</em><b>{i === 0 ? "SYS" : "CORE"}</b>{log}</span>)}</div>}
      </section>
      {(publishedUrl || (!sharedMode && shareError)) && <div className="publish-backdrop" role="dialog" aria-modal="true" aria-label="Published project">
        <div className="publish-modal panel">
          <button className="publish-close" onClick={() => { setPublishedUrl(""); setShareError(""); }}>×</button>
          {publishedUrl ? <>
            <span className="publish-kicker">PROJECT STORAGE / ONLINE</span>
            <h2>READY FOR MOBILE</h2>
            <p>VRM、動作、音訊與 Target 已存入同一個專案。手機掃描後只會載入素材，不需要再上傳。</p>
            {/* QR is generated as an in-memory data URL, so image optimization does not apply. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {qrCodeUrl && <img src={qrCodeUrl} alt="Shared project QR code" />}
            {launchCode && <div className="launch-code-result"><span>QUEST LAUNCH CODE</span><b>{launchCode}</b><small>Quest 開啟網站首頁，輸入此代碼即可載入專案。</small></div>}
            <label>PROJECT URL</label>
            <code>{publishedUrl}</code>
            <div className="publish-actions">
              <button onClick={() => navigator.clipboard.writeText(publishedUrl)}>COPY LINK</button>
              <a href={publishedUrl} target="_blank" rel="noreferrer">OPEN MOBILE VIEW ↗</a>
            </div>
            <small>手機掃碼後按 START AR CAMERA，即會使用同一個 Project ID 與同一套 Avatar Core 啟動 MindAR。</small>
          </> : <>
            <span className="publish-kicker error">PUBLISH BLOCKED</span>
            <h2>無法發佈專案</h2>
            <p>{shareError}</p>
            <button className="modal-import" onClick={() => { setShareError(""); fileRef.current?.click(); }}>IMPORT VRM</button>
          </>}
        </div>
      </div>}
      {launchOpen && !sharedMode && <div className="publish-backdrop" role="dialog" aria-modal="true" aria-label="Quest Launch Code">
        <div className="quest-launch-modal panel">
          <button className="publish-close" onClick={() => setLaunchOpen(false)}>×</button>
          <span className="publish-kicker">QUEST EXHIBITION LAUNCHER</span>
          <h2>輸入專案代碼</h2>
          <p>代碼不分大小寫，可省略「XR-」與連字號。</p>
          <input value={launchInput} onChange={event => setLaunchInput(event.target.value.toUpperCase())} onKeyDown={event => { if (event.key === "Enter") void resolveLaunchCode(); }} placeholder="XR-A7K29Q" maxLength={9} autoFocus />
          {launchError && <div className="launch-error">{launchError}</div>}
          <button className="launch-submit" onClick={() => void resolveLaunchCode()} disabled={launchLoading}>{launchLoading ? "LOADING PROJECT…" : "LOAD XR PROJECT"}</button>
          <small>Launch Code 是公開專案入口，不是密碼。</small>
        </div>
      </div>}
    </main>
  );
}
