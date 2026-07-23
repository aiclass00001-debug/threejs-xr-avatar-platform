import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { IRuntime } from "./IRuntime";

export class ViewerRuntime implements IRuntime {
  readonly id = "viewer" as const;
  readonly root = new THREE.Group();
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private renderer?: THREE.WebGLRenderer;
  private controls?: OrbitControls;
  private observer?: ResizeObserver;

  async start(host: HTMLDivElement) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    this.camera.position.set(0, 1.35, 3.3);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    host.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.15, 0);
    this.controls.enableDamping = true;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 6;
    this.scene.add(new THREE.HemisphereLight(0xc7e7ff, 0x101026, 2.4));
    const key = new THREE.DirectionalLight(0x69d9ff, 4.2); key.position.set(2.5, 3.5, 3); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xff39c6, 5); rim.position.set(-3, 2, -2); this.scene.add(rim);
    this.scene.add(this.root);
    const resize = () => {
      if (!this.renderer || !this.camera) return;
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    };
    this.observer = new ResizeObserver(resize);
    this.observer.observe(host);
    resize();
  }

  async requestSession() { /* Viewer has no immersive session. */ }
  reset() {
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
    this.root.scale.setScalar(1);
    this.controls?.reset();
  }
  async stop() { this.observer?.disconnect(); }
  update() {
    this.controls?.update();
    if (this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera);
  }
  dispose() {
    this.controls?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.root.removeFromParent();
  }
}
