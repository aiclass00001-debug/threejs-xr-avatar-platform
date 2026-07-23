import * as THREE from "three";
import type { IRuntime, TargetPlacementMode } from "./IRuntime";

type MindARInstance = {
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  cssRenderer: { domElement: HTMLElement; render(scene: THREE.Scene, camera: THREE.Camera): void };
  addAnchor(index: number): { group: THREE.Group; onTargetFound: (() => void) | null; onTargetLost: (() => void) | null };
  start(): Promise<void>;
  stop(): void;
};

export class MindARRuntime implements IRuntime {
  readonly id = "mindar" as const;
  readonly root = new THREE.Group();
  private instance?: MindARInstance;
  private deviceBeta: number | null = null;
  private targetVisible = false;
  private resolvedPlacement: Exclude<TargetPlacementMode, "auto"> = "screen";
  private readonly onDeviceOrientation = (event: DeviceOrientationEvent) => {
    if (typeof event.beta !== "number") return;
    this.deviceBeta = event.beta;
    if (this.targetVisible && this.placementMode === "auto") this.applyPlacement();
  };

  constructor(
    private readonly imageTargetSrc: string,
    private readonly onStatus: (status: "starting" | "scanning" | "found" | "lost") => void,
    private readonly placementMode: TargetPlacementMode = "auto",
    private readonly onPlacementResolved?: (placement: "screen" | "table") => void,
  ) {
    this.root.scale.setScalar(0.62);
  }

  private applyPlacement() {
    let placement: "screen" | "table";
    if (this.placementMode !== "auto") {
      placement = this.placementMode;
    } else if (this.deviceBeta === null) {
      placement = "screen";
    } else {
      // Portrait phones are near 90° when aimed at a wall/screen and near 0°
      // when held over a horizontal target. Hysteresis prevents rapid flips.
      const tilt = Math.abs(this.deviceBeta);
      placement = this.resolvedPlacement === "table"
        ? (tilt > 58 ? "screen" : "table")
        : (tilt < 42 ? "table" : "screen");
    }
    if (placement === this.resolvedPlacement && this.root.rotation.x === (placement === "table" ? Math.PI / 2 : 0)) return;
    this.resolvedPlacement = placement;
    this.root.rotation.set(placement === "table" ? Math.PI / 2 : 0, 0, 0);
    this.root.updateMatrix();
    this.onPlacementResolved?.(placement);
  }

  async start(host: HTMLDivElement) {
    this.onStatus("starting");
    window.addEventListener("deviceorientation", this.onDeviceOrientation, true);
    const { MindARThree } = await import("mind-ar/dist/mindar-image-three.prod.js");
    const instance = new MindARThree({
      container: host,
      imageTargetSrc: this.imageTargetSrc,
      maxTrack: 1,
      uiLoading: "no",
      uiScanning: "no",
      uiError: "no",
    }) as MindARInstance;
    this.instance = instance;
    instance.scene.add(new THREE.HemisphereLight(0xffffff, 0x334466, 2.5));
    const key = new THREE.DirectionalLight(0xffffff, 3.4); key.position.set(1, 3, 2); instance.scene.add(key);
    const anchor = instance.addAnchor(0);
    anchor.group.add(this.root);
    anchor.onTargetFound = () => {
      this.targetVisible = true;
      this.applyPlacement();
      this.onStatus("found");
    };
    anchor.onTargetLost = () => {
      this.targetVisible = false;
      this.onStatus("lost");
    };
    await instance.start();
    this.onStatus("scanning");
  }

  async requestSession() { /* Camera tracking is started by start(). */ }
  reset() {
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.root.scale.setScalar(0.62);
    this.applyPlacement();
  }
  async stop() {
    window.removeEventListener("deviceorientation", this.onDeviceOrientation, true);
    this.targetVisible = false;
    try { this.instance?.stop(); } catch { /* A denied camera may stop before the controller exists. */ }
  }
  update() {
    if (!this.instance) return;
    this.instance.renderer.render(this.instance.scene, this.instance.camera);
    this.instance.cssRenderer.render(this.instance.scene, this.instance.camera);
  }
  dispose() {
    window.removeEventListener("deviceorientation", this.onDeviceOrientation, true);
    this.root.removeFromParent();
    this.instance?.renderer.dispose();
    this.instance?.renderer.domElement.remove();
    this.instance?.cssRenderer.domElement.remove();
    this.instance = undefined;
  }
}
