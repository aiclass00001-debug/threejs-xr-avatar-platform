import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

const mixamoToVrm: Record<string, string> = {
  mixamorigHips:"hips", mixamorigSpine:"spine", mixamorigSpine1:"chest", mixamorigSpine2:"upperChest", mixamorigNeck:"neck", mixamorigHead:"head",
  mixamorigLeftShoulder:"leftShoulder", mixamorigLeftArm:"leftUpperArm", mixamorigLeftForeArm:"leftLowerArm", mixamorigLeftHand:"leftHand",
  mixamorigRightShoulder:"rightShoulder", mixamorigRightArm:"rightUpperArm", mixamorigRightForeArm:"rightLowerArm", mixamorigRightHand:"rightHand",
  mixamorigLeftUpLeg:"leftUpperLeg", mixamorigLeftLeg:"leftLowerLeg", mixamorigLeftFoot:"leftFoot", mixamorigLeftToeBase:"leftToes",
  mixamorigRightUpLeg:"rightUpperLeg", mixamorigRightLeg:"rightLowerLeg", mixamorigRightFoot:"rightFoot", mixamorigRightToeBase:"rightToes",
};
for (const side of ["Left", "Right"] as const) {
  const vrmSide = side.toLowerCase();
  for (const [mixamo, vrm] of [["Index","Index"],["Middle","Middle"],["Ring","Ring"],["Pinky","Little"]] as const) {
    mixamoToVrm[`mixamorig${side}Hand${mixamo}1`] = `${vrmSide}${vrm}Proximal`;
    mixamoToVrm[`mixamorig${side}Hand${mixamo}2`] = `${vrmSide}${vrm}Intermediate`;
    mixamoToVrm[`mixamorig${side}Hand${mixamo}3`] = `${vrmSide}${vrm}Distal`;
  }
  mixamoToVrm[`mixamorig${side}HandThumb1`] = `${vrmSide}ThumbMetacarpal`;
  mixamoToVrm[`mixamorig${side}HandThumb2`] = `${vrmSide}ThumbProximal`;
  mixamoToVrm[`mixamorig${side}HandThumb3`] = `${vrmSide}ThumbDistal`;
}

const stripNamespace = (name: string) => name.replace(/^.*:/, "");
const findNode = (asset: THREE.Group, canonical: string) => {
  let result: THREE.Object3D | undefined;
  asset.traverse(node => { if (!result && stripNamespace(node.name) === canonical) result = node; });
  return result;
};

export function retargetMixamoAnimation(vrm: VRM, asset: THREE.Group): THREE.AnimationClip {
  const source = (THREE.AnimationClip.findByName(asset.animations,"mixamo.com") || asset.animations[0])?.clone();
  if (!source) throw new Error("FBX does not contain a Mixamo AnimationClip");
  asset.updateMatrixWorld(true); vrm.scene.updateMatrixWorld(true);
  const sourceHips = findNode(asset,"mixamorigHips");
  const targetHips = vrm.humanoid?.getNormalizedBoneNode("hips");
  if (!sourceHips || !targetHips) throw new Error("Mixamo Hips or VRM Hips was not found");

  const vec = new THREE.Vector3();
  const motionHipsHeight = Math.max(.001,Math.abs(sourceHips.position.y));
  const vrmHipsY = targetHips.getWorldPosition(vec).y;
  const vrmRootY = vrm.scene.getWorldPosition(vec).y;
  const hipsScale = Math.abs(vrmHipsY-vrmRootY)/motionHipsHeight;
  const restWorldInverse = new THREE.Quaternion();
  const parentRestWorld = new THREE.Quaternion();
  const quat = new THREE.Quaternion();
  const isVrm0 = vrm.meta?.metaVersion === "0";
  const tracks: THREE.KeyframeTrack[] = [];

  source.tracks.forEach(track => {
    const dot = track.name.lastIndexOf("."); if (dot < 0) return;
    const sourceName = stripNamespace(track.name.slice(0,dot));
    const canonical = sourceName.startsWith("mixamorig") ? sourceName : `mixamorig${sourceName}`;
    const vrmBone = mixamoToVrm[canonical]; if (!vrmBone) return;
    const sourceNode = findNode(asset,canonical);
    const targetNode = vrm.humanoid?.getNormalizedBoneNode(vrmBone as never);
    if (!sourceNode || !sourceNode.parent || !targetNode) return;
    const property = track.name.slice(dot+1);
    sourceNode.getWorldQuaternion(restWorldInverse).invert();
    sourceNode.parent.getWorldQuaternion(parentRestWorld);

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = new Float32Array(track.values.length);
      for (let i=0;i<track.values.length;i+=4) {
        quat.fromArray(track.values,i).premultiply(parentRestWorld).multiply(restWorldInverse).normalize();
        values[i] = isVrm0 ? -quat.x : quat.x; values[i+1] = quat.y; values[i+2] = isVrm0 ? -quat.z : quat.z; values[i+3] = quat.w;
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${targetNode.name}.${property}`,track.times,values));
    } else if (track instanceof THREE.VectorKeyframeTrack && vrmBone === "hips") {
      const values = new Float32Array(track.values.length);
      for (let i=0;i<track.values.length;i+=3) {
        values[i] = track.values[i]*hipsScale*(isVrm0?-1:1);
        values[i+1] = track.values[i+1]*hipsScale;
        values[i+2] = track.values[i+2]*hipsScale*(isVrm0?-1:1);
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${targetNode.name}.${property}`,track.times,values));
    }
  });
  if (!tracks.length) throw new Error("No compatible Mixamo bone tracks were detected");
  return new THREE.AnimationClip(source.name || "Mixamo Motion",source.duration,tracks);
}
