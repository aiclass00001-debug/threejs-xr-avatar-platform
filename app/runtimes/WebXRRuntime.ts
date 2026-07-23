import * as THREE from "three";
import type { IRuntime } from "./IRuntime";

export type WebXRStatus = "checking" | "ready" | "unsupported" | "starting" | "scanning" | "placed" | "ended" | "error";

type XRNavigator = Navigator & {
  xr?: {
    isSessionSupported(mode: XRSessionMode): Promise<boolean>;
    requestSession(mode: XRSessionMode, options?: XRSessionInit): Promise<XRSession>;
  };
};

export class WebXRRuntime implements IRuntime {
  readonly id = "webxr" as const;
  readonly root = new THREE.Group();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.01, 40);
  private readonly clock = new THREE.Clock();
  private renderer?: THREE.WebGLRenderer;
  private observer?: ResizeObserver;
  private session?: XRSession;
  private hitTestSource?: XRHitTestSource;
  private supported = false;
  private stopping = false;
  private disposed = false;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private readonly inputs: THREE.Group[] = [];
  private readonly activeGrabs = new Set<THREE.Group>();
  private readonly reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.075, 0.095, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x27c6ff, transparent: true, opacity: 0.9 }),
  );
  private readonly placementPosition = new THREE.Vector3();
  private readonly placementRotation = new THREE.Quaternion();
  private readonly placementScale = new THREE.Vector3();
  private readonly headsetPosition = new THREE.Vector3();
  private readonly directionToHeadset = new THREE.Vector3();
  private readonly baselineRootPosition = new THREE.Vector3();
  private readonly baselineRootQuaternion = new THREE.Quaternion();
  private readonly baselineRootScale = new THREE.Vector3();
  private readonly baselinePrimaryPosition = new THREE.Vector3();
  private readonly baselineMidpoint = new THREE.Vector3();
  private readonly baselineVector = new THREE.Vector3();
  private readonly currentPrimaryPosition = new THREE.Vector3();
  private readonly currentSecondaryPosition = new THREE.Vector3();
  private readonly currentMidpoint = new THREE.Vector3();
  private readonly currentVector = new THREE.Vector3();
  private readonly rootOffset = new THREE.Vector3();
  private readonly yawQuaternion = new THREE.Quaternion();
  private baselineDistance = 1;

  constructor(
    private readonly onStatus: (status: WebXRStatus, detail?: string) => void,
    private readonly onFrame: (delta: number) => void,
  ) {
    this.root.visible = false;
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.scene.add(this.root, this.reticle);
  }

  async start(host: HTMLDivElement) {
    this.disposed = false;
    this.stopping = false;
    this.onStatus("checking");
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.xr.enabled = true;
    // `local` is universally available in immersive sessions; hit-test still
    // returns the detected floor pose while devices may omit local-floor.
    this.renderer.xr.setReferenceSpaceType("local");
    host.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334466, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.2);
    key.position.set(1, 3, 2);
    this.scene.add(key);
    this.addInputs();

    const resize = () => {
      if (!this.renderer) return;
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    };
    this.observer = new ResizeObserver(resize);
    this.observer.observe(host);
    resize();

    this.renderer.setAnimationLoop((_time: number, frame?: XRFrame) => {
      const delta = Math.min(this.clock.getDelta(), 0.05);
      if (frame) this.updateHitTest(frame);
      this.updateGrabTransform();
      this.onFrame(delta);
      this.renderer?.render(this.scene, this.camera);
    });

    const xr = (navigator as XRNavigator).xr;
    this.supported = Boolean(xr && await xr.isSessionSupported("immersive-ar").catch(() => false));
    this.onStatus(this.supported ? "ready" : "unsupported", this.supported
      ? "Quest ready. Enter AR, scan the floor, then Trigger or Pinch to place."
      : "This browser does not expose WebXR immersive-ar.");
  }

  private addInputs() {
    if (!this.renderer) return;
    for (let index = 0; index < 2; index += 1) {
      const controller = this.renderer.xr.getController(index);
      const ray = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -0.8)]),
        new THREE.LineBasicMaterial({ color: 0x27c6ff, transparent: true, opacity: 0.7 }),
      );
      controller.add(ray);
      controller.addEventListener("select", () => {
        if (!this.root.visible) this.placeAvatar();
      });
      controller.addEventListener("selectstart", () => this.beginGrab(controller));
      controller.addEventListener("selectend", () => this.endGrab(controller));
      controller.addEventListener("squeezestart", () => this.beginGrab(controller));
      controller.addEventListener("squeezeend", () => this.endGrab(controller));
      this.inputs.push(controller);
      this.scene.add(controller, this.renderer.xr.getControllerGrip(index), this.renderer.xr.getHand(index));
    }
  }

  async requestSession() {
    const xr = (navigator as XRNavigator).xr;
    if (!xr || !this.renderer) {
      this.onStatus("unsupported", "This browser does not expose WebXR immersive-ar.");
      return;
    }
    if (this.session) return;
    this.clearRecoveryTimer();
    this.stopping = false;
    this.reset();
    this.onStatus("starting");
    try {
      const session = await xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test"],
        optionalFeatures: ["local-floor", "bounded-floor", "hand-tracking", "plane-detection", "dom-overlay"],
        domOverlay: { root: document.body },
      });
      this.session = session;
      session.addEventListener("end", () => this.handleSessionEnd());
      await this.renderer.xr.setSession(session);
      const viewerSpace = await session.requestReferenceSpace("viewer");
      if (!session.requestHitTestSource) throw new Error("This WebXR session does not provide hit-test.");
      this.hitTestSource = await session.requestHitTestSource({ space: viewerSpace }) ?? undefined;
      this.clock.start();
      this.onStatus("scanning", "Move the device slowly until the floor reticle appears.");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unable to start immersive AR.";
      this.onStatus("error", detail);
      this.scheduleReady("Session recovered. Press Enter Immersive AR to try again.");
    }
  }

  private updateHitTest(frame: XRFrame) {
    const referenceSpace = this.renderer?.xr.getReferenceSpace();
    if (!referenceSpace || !this.hitTestSource) return;
    const hit = frame.getHitTestResults(this.hitTestSource)[0];
    const pose = hit?.getPose(referenceSpace);
    this.reticle.visible = Boolean(pose);
    if (pose) this.reticle.matrix.fromArray(pose.transform.matrix);
  }

  private placeAvatar() {
    if (!this.reticle.visible) return;
    this.reticle.matrix.decompose(this.placementPosition, this.placementRotation, this.placementScale);
    this.root.position.copy(this.placementPosition);
    const xrCamera = this.renderer?.xr.getCamera();
    xrCamera?.getWorldPosition(this.headsetPosition);
    this.directionToHeadset.subVectors(this.headsetPosition, this.placementPosition);
    this.directionToHeadset.y = 0;
    if (this.directionToHeadset.lengthSq() > 1e-6) {
      // VRM front is +Z. Face the user while keeping the avatar upright;
      // a floor hit pose may contain an arbitrary 180° yaw on Quest.
      const yaw = Math.atan2(this.directionToHeadset.x, this.directionToHeadset.z);
      this.root.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    } else {
      this.root.quaternion.identity();
    }
    this.root.scale.setScalar(0.72);
    this.root.visible = true;
    this.root.updateWorldMatrix(true, true);
    this.onStatus("placed", "Pinch or Trigger to move. Use two hands to rotate and scale.");
  }

  private beginGrab(input: THREE.Group) {
    if (!this.root.visible) return;
    this.activeGrabs.add(input);
    this.captureGrabBaseline();
  }

  private endGrab(input: THREE.Group) {
    if (!this.activeGrabs.delete(input)) return;
    this.captureGrabBaseline();
  }

  private captureGrabBaseline() {
    this.root.updateWorldMatrix(true, false);
    this.root.getWorldPosition(this.baselineRootPosition);
    this.root.getWorldQuaternion(this.baselineRootQuaternion);
    this.root.getWorldScale(this.baselineRootScale);
    const grabs = Array.from(this.activeGrabs);
    if (!grabs.length) return;
    grabs[0].getWorldPosition(this.baselinePrimaryPosition);
    if (grabs.length < 2) return;
    grabs[1].getWorldPosition(this.currentSecondaryPosition);
    this.baselineMidpoint.copy(this.baselinePrimaryPosition).add(this.currentSecondaryPosition).multiplyScalar(0.5);
    this.baselineVector.subVectors(this.currentSecondaryPosition, this.baselinePrimaryPosition);
    this.baselineDistance = Math.max(this.baselineVector.length(), 0.05);
  }

  private updateGrabTransform() {
    if (!this.root.visible || !this.activeGrabs.size) return;
    const grabs = Array.from(this.activeGrabs);
    grabs[0].getWorldPosition(this.currentPrimaryPosition);
    if (grabs.length === 1) {
      this.root.position.copy(this.baselineRootPosition)
        .add(this.currentPrimaryPosition)
        .sub(this.baselinePrimaryPosition);
      this.root.updateWorldMatrix(true, true);
      return;
    }

    grabs[1].getWorldPosition(this.currentSecondaryPosition);
    this.currentMidpoint.copy(this.currentPrimaryPosition).add(this.currentSecondaryPosition).multiplyScalar(0.5);
    this.currentVector.subVectors(this.currentSecondaryPosition, this.currentPrimaryPosition);
    const rawRatio = this.currentVector.length() / this.baselineDistance;
    const baselineScalar = Math.max(this.baselineRootScale.x, 0.001);
    const ratio = THREE.MathUtils.clamp(rawRatio, 0.2 / baselineScalar, 2.4 / baselineScalar);

    const baseX = this.baselineVector.x;
    const baseZ = this.baselineVector.z;
    const currentX = this.currentVector.x;
    const currentZ = this.currentVector.z;
    const baseLength = Math.hypot(baseX, baseZ);
    const currentLength = Math.hypot(currentX, currentZ);
    const yaw = baseLength > 0.025 && currentLength > 0.025
      ? Math.atan2(baseZ * currentX - baseX * currentZ, baseX * currentX + baseZ * currentZ)
      : 0;
    this.yawQuaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    this.root.quaternion.copy(this.yawQuaternion).multiply(this.baselineRootQuaternion);
    this.root.scale.copy(this.baselineRootScale).multiplyScalar(ratio);

    this.rootOffset.subVectors(this.baselineRootPosition, this.baselineMidpoint)
      .multiplyScalar(ratio)
      .applyQuaternion(this.yawQuaternion);
    this.root.position.copy(this.currentMidpoint).add(this.rootOffset);
    this.root.updateWorldMatrix(true, true);
  }

  reset() {
    this.activeGrabs.clear();
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
    this.root.scale.setScalar(0.72);
    this.root.visible = false;
    this.reticle.visible = false;
    if (this.session) this.onStatus("scanning", "Demo reset. Scan the floor and Trigger or Pinch to place again.");
  }

  private handleSessionEnd() {
    this.hitTestSource?.cancel();
    this.hitTestSource = undefined;
    this.session = undefined;
    this.reticle.visible = false;
    this.root.visible = false;
    this.activeGrabs.clear();
    if (this.stopping || this.disposed) return;
    this.onStatus("ended", "XR session ended. Restoring the exhibition launcher…");
    this.scheduleReady("Session recovered. Press Enter Immersive AR to continue without reloading the project.");
  }

  private scheduleReady(detail: string) {
    this.clearRecoveryTimer();
    this.recoveryTimer = setTimeout(() => {
      if (!this.supported || this.stopping || this.disposed || this.session) return;
      this.onStatus("ready", detail);
    }, 650);
  }

  private clearRecoveryTimer() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  async stop() {
    this.stopping = true;
    this.clearRecoveryTimer();
    this.activeGrabs.clear();
    this.observer?.disconnect();
    const session = this.session;
    this.session = undefined;
    if (session) await session.end().catch(() => undefined);
  }

  update() { /* WebXR renders through WebGLRenderer.setAnimationLoop(). */ }

  dispose() {
    this.disposed = true;
    this.clearRecoveryTimer();
    this.renderer?.setAnimationLoop(null);
    this.hitTestSource?.cancel();
    this.reticle.geometry.dispose();
    (this.reticle.material as THREE.Material).dispose();
    this.scene.traverse(object => {
      if (object instanceof THREE.Line) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.root.removeFromParent();
    this.renderer = undefined;
  }
}
