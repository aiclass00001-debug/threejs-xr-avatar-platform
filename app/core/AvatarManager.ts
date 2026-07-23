import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { FaceFrame } from "../WebcamFaceTracker";
import type { LipSyncFrame } from "../AudioLipSync";
import { retargetMixamoAnimation } from "../retargetMixamo";

export class AvatarManager {
  private vrm: VRM | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private action: THREE.AnimationAction | null = null;
  private root: THREE.Object3D | null = null;
  private providerWasActive = false;
  private loadRevision = 0;
  private readonly physicsCenter = new THREE.Object3D();
  private readonly springGravity = new Map<object, THREE.Vector3>();
  private readonly springGravityRotation = new THREE.Quaternion();
  private trackingMotionGuard = false;
  private trackingPoseValid = false;
  private readonly trackingPosition = new THREE.Vector3();
  private readonly trackingRotation = new THREE.Quaternion();
  private readonly trackingScale = new THREE.Vector3();
  private readonly nextTrackingPosition = new THREE.Vector3();
  private readonly nextTrackingRotation = new THREE.Quaternion();
  private readonly nextTrackingScale = new THREE.Vector3();

  get ready() { return Boolean(this.vrm); }

  async load(url: string) {
    const revision = ++this.loadRevision;
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    if (revision !== this.loadRevision) throw new Error("VRM load superseded");
    const vrm = gltf.userData.vrm as VRM;
    if (!vrm) throw new Error("This file does not contain a valid VRM avatar");
    this.disposeAvatar();
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse(object => { object.frustumCulled = false; });
    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.springGravity.clear();
    vrm.springBoneManager?.joints.forEach(joint => {
      this.springGravity.set(joint, joint.settings.gravityDir.clone());
    });
    if (this.root) {
      this.root.add(this.physicsCenter);
      this.root.add(vrm.scene);
      this.resetSecondaryMotion();
    }
    return vrm.meta?.name || "VRM Avatar";
  }

  attach(root: THREE.Object3D) {
    if (this.root === root) return;
    this.detach();
    this.root = root;
    if (this.vrm) {
      root.add(this.physicsCenter);
      root.add(this.vrm.scene);
      this.resetSecondaryMotion();
    }
  }

  detach() {
    const springBones = this.vrm?.springBoneManager;
    if (springBones) springBones.joints.forEach(joint => { joint.center = null; });
    this.physicsCenter.removeFromParent();
    this.vrm?.scene.removeFromParent();
    this.root = null;
    this.trackingPoseValid = false;
  }

  setTrackingMotionGuard(enabled: boolean) {
    this.trackingMotionGuard = enabled;
    this.trackingPoseValid = false;
  }

  /**
   * Keeps secondary motion in the avatar root's coordinate system. Tracking
   * runtimes can move their anchor abruptly; using world space would make
   * hair and accessories look as if they had been thrown away from the VRM.
   */
  resetSecondaryMotion() {
    const vrm = this.vrm;
    const springBones = vrm?.springBoneManager;
    const center = this.physicsCenter.parent ? this.physicsCenter : null;
    if (!vrm || !springBones || !center) return false;

    center.updateWorldMatrix(true, true);
    vrm.scene.updateWorldMatrix(true, true);
    const determinant = center.matrixWorld.determinant();
    // MindAR uses a non-invertible hidden matrix before a target is found.
    // Never feed that matrix into the SpringBone solver.
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) return false;

    springBones.joints.forEach(joint => { joint.center = center; });
    this.alignSpringGravity(center);
    springBones.reset();
    this.captureTrackingPose(center);
    return true;
  }

  private captureTrackingPose(center: THREE.Object3D) {
    center.matrixWorld.decompose(this.trackingPosition, this.trackingRotation, this.trackingScale);
    this.trackingPoseValid = true;
  }

  private trackingPoseJumped(center: THREE.Object3D) {
    center.matrixWorld.decompose(this.nextTrackingPosition, this.nextTrackingRotation, this.nextTrackingScale);
    if (!this.trackingPoseValid) {
      this.captureTrackingPose(center);
      return false;
    }
    const positionJump = this.nextTrackingPosition.distanceTo(this.trackingPosition) > 0.085;
    const rotationJump = this.nextTrackingRotation.angleTo(this.trackingRotation) > THREE.MathUtils.degToRad(14);
    const scaleJump = this.nextTrackingScale.distanceTo(this.trackingScale) > 0.12;
    this.trackingPosition.copy(this.nextTrackingPosition);
    this.trackingRotation.copy(this.nextTrackingRotation);
    this.trackingScale.copy(this.nextTrackingScale);
    return positionJump || rotationJump || scaleJump;
  }

  private alignSpringGravity(center: THREE.Object3D) {
    const springBones = this.vrm?.springBoneManager;
    if (!springBones) return;
    center.getWorldQuaternion(this.springGravityRotation);
    springBones.joints.forEach(joint => {
      const localDirection = this.springGravity.get(joint);
      if (localDirection) {
        // VRM SpringBone applies gravityDir in world space. Rotate the VRM's
        // authored direction with the injected runtime root so "down" remains
        // avatar-local even when an image anchor lies on a table or wall.
        joint.settings.gravityDir.copy(localDirection).applyQuaternion(this.springGravityRotation);
      }
    });
  }

  async loadAnimation(url: string, loop: boolean, playing: boolean) {
    if (!this.vrm || !this.mixer) throw new Error("Load a VRM before loading animation");
    const asset = await new FBXLoader().loadAsync(url);
    this.vrm.humanoid?.resetNormalizedPose();
    const clip = retargetMixamoAnimation(this.vrm, asset);
    const previous = this.action;
    const next = this.mixer.clipAction(clip);
    next.reset(); next.enabled = true; next.clampWhenFinished = !loop;
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.paused = !playing; next.fadeIn(.28).play(); previous?.fadeOut(.28);
    this.action = next;
    return clip.name;
  }

  setAnimationState(playing: boolean, loop: boolean) {
    if (!this.action) return;
    this.action.paused = !playing;
    this.action.clampWhenFinished = !loop;
    this.action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
  }

  resetDemo() {
    this.action?.reset().play();
    this.vrm?.humanoid?.resetNormalizedPose();
    this.vrm?.expressionManager?.resetValues();
    this.providerWasActive = false;
    this.root?.updateWorldMatrix(true, true);
    this.vrm?.scene.updateWorldMatrix(true, true);
    this.resetSecondaryMotion();
  }

  update(delta: number, face: FaceFrame, lip: LipSyncFrame, manualExpression: string) {
    const vrm = this.vrm;
    if (!vrm) return;
    if (this.providerWasActive && !face.providerActive) vrm.humanoid?.resetNormalizedPose();
    this.providerWasActive = face.providerActive;
    const manager = vrm.expressionManager;
    const smooth = Math.min(1, delta * 12);
    const blend = (name: string, value: number) => manager?.setValue(name, THREE.MathUtils.lerp(manager.getValue(name) ?? 0, value, smooth));

    if (face.active) {
      blend("blinkLeft", face.blinkLeft); blend("blinkRight", face.blinkRight);
      blend("aa", face.jawOpen); blend("oh", Math.max(face.mouthFunnel, face.jawOpen * .25)); blend("ou", face.mouthPucker);
      blend("happy", face.smile); blend("surprised", face.browUp * .55);
      const neck = vrm.humanoid?.getNormalizedBoneNode("neck");
      if (neck) {
        const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(face.head.x * .55, -face.head.y * .65, -face.head.z * .55));
        neck.quaternion.slerp(target, Math.min(1, delta * 8));
      }
      if (face.poseActive && face.bodyRig) {
        const rig = face.bodyRig;
        const rotate = (bone: "chest" | "spine" | "leftUpperArm" | "leftLowerArm" | "rightUpperArm" | "rightLowerArm", value: {x:number;y:number;z:number}, scale = {x:1,y:1,z:1}) => {
          const node = vrm.humanoid?.getNormalizedBoneNode(bone);
          if (!node) return;
          const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(value.x * scale.x, value.y * scale.y, value.z * scale.z));
          node.quaternion.slerp(target, Math.min(1, delta * 8));
        };
        rotate("chest", rig.spine, {x:.22,y:.22,z:.22}); rotate("spine", rig.spine, {x:.1,y:.1,z:.1});
        rotate("leftUpperArm", rig.leftUpperArm); rotate("leftLowerArm", rig.leftLowerArm);
        rotate("rightUpperArm", rig.rightUpperArm); rotate("rightLowerArm", rig.rightLowerArm);
      }
      const applyHand = (points: Array<{x:number;y:number;z:number;visibility?:number}>, side: "left" | "right") => {
        if (points.length !== 21) return;
        const fingerSets = [
          ["Thumb", [1,2,3,4]], ["Index", [5,6,7,8]], ["Middle", [9,10,11,12]],
          ["Ring", [13,14,15,16]], ["Little", [17,18,19,20]],
        ] as const;
        const vector = (from:number, to:number) => new THREE.Vector3(points[to].x-points[from].x, -(points[to].y-points[from].y), -(points[to].z-points[from].z)).normalize();
        const curl = (a:number,b:number,c:number) => Math.acos(THREE.MathUtils.clamp(vector(b,a).dot(vector(b,c)), -1, 1));
        fingerSets.forEach(([finger, ids]) => {
          const joints = finger === "Thumb" ? ["Metacarpal","Proximal","Distal"] : ["Proximal","Intermediate","Distal"];
          const values = [curl(ids[0],ids[1],ids[2]), curl(ids[1],ids[2],ids[3]), curl(ids[1],ids[2],ids[3])];
          joints.forEach((joint,index) => {
            const boneName = `${side}${finger}${joint}` as Parameters<NonNullable<VRM["humanoid"]>["getNormalizedBoneNode"]>[0];
            const node = vrm.humanoid?.getNormalizedBoneNode(boneName);
            if (!node) return;
            const amount = THREE.MathUtils.clamp(Math.PI-values[index],0,1.35);
            const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(side === "left" ? amount : -amount,0,0));
            node.quaternion.slerp(target,Math.min(1,delta*10));
          });
        });
      };
      if (face.handsActive) { applyHand(face.leftHand,"left"); applyHand(face.rightHand,"right"); }
    } else {
      const selected = manualExpression.toLowerCase();
      blend("blinkLeft", 0); blend("blinkRight", 0);
      blend("aa", lip.active ? lip.aa : 0); blend("ih", lip.active ? lip.ih : 0); blend("ee", lip.active ? lip.ee : 0);
      blend("oh", lip.active ? lip.oh : 0); blend("ou", lip.active ? lip.ou : 0);
      ["happy", "angry", "sad", "surprised"].forEach(name => blend(name, name === selected ? 1 : 0));
    }
    if (!face.providerActive) this.mixer?.update(delta);
    // Refresh the injected runtime root before SpringBone evaluates its center.
    // This makes Viewer and moving AR anchors follow the same Avatar pipeline.
    this.root?.updateWorldMatrix(true, true);
    this.physicsCenter.updateWorldMatrix(true, false);
    this.alignSpringGravity(this.physicsCenter);
    vrm.scene.updateWorldMatrix(true, true);
    if (this.trackingMotionGuard && this.trackingPoseJumped(this.physicsCenter)) {
      // A camera/anchor discontinuity must not become secondary-bone velocity.
      // Reset after the current animation pose has been evaluated below.
      vrm.humanoid.update();
      vrm.lookAt?.update(delta);
      vrm.expressionManager?.update();
      vrm.nodeConstraintManager?.update();
      vrm.scene.updateWorldMatrix(true, true);
      vrm.springBoneManager?.reset();
      vrm.springBoneManager?.update(Math.min(delta, 1 / 60));
      vrm.materials?.forEach(material => {
        const animated = material as THREE.Material & { update?: (step: number) => void };
        animated.update?.(delta);
      });
    } else {
      vrm.update(this.trackingMotionGuard ? Math.min(delta, 1 / 30) : delta);
    }
  }

  dispose() {
    this.loadRevision += 1;
    this.detach();
    this.disposeAvatar();
  }

  private disposeAvatar() {
    this.action = null;
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.springGravity.clear();
    if (this.vrm) {
      this.vrm.scene.removeFromParent();
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
  }
}
