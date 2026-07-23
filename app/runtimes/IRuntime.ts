import type * as THREE from "three";

export type RuntimeId = "viewer" | "mindar" | "webxr";
export type TargetPlacementMode = "auto" | "screen" | "table";

export interface IRuntime {
  readonly id: RuntimeId;
  readonly root: THREE.Group;
  start(host: HTMLDivElement): Promise<void>;
  requestSession(): Promise<void>;
  reset(): void;
  stop(): Promise<void>;
  update(delta: number): void;
  dispose(): void;
}
