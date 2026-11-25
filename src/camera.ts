// Orbit camera: right-drag orbit, middle-drag pan, wheel zoom (smoothed), damping,
// limits, anti-clipping against the voxel grid, camera shake and a cinematic mode.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SX, SY, SZ } from './sim/constants.ts';

export class CameraRig {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  private targetDist: number;
  private shake = 0;
  private shakeOffset = new THREE.Vector3();
  cinematic = false;
  private cineT = 0;
  private solidAt: (x: number, y: number, z: number) => boolean;

  constructor(dom: HTMLElement, solidAt: (x: number, y: number, z: number) => boolean) {
    this.solidAt = solidAt;
    this.camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.5, 2000);
    this.camera.position.set(64 + 120, 34 + 85, 64 + 120);
    const c = new OrbitControls(this.camera, dom);
    c.target.set(64, 30, 64);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.rotateSpeed = 0.55;
    c.panSpeed = 0.8;
    c.minDistance = 22;
    c.maxDistance = 340;
    c.minPolarAngle = 0.08;
    c.maxPolarAngle = Math.PI * 0.82;
    c.zoomSpeed = 0.8;
    c.screenSpacePanning = true;
    c.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    c.touches = { ONE: null as unknown as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_ROTATE };
    c.autoRotateSpeed = 0.5;
    c.update();
    this.controls = c;
    this.targetDist = this.camera.position.distanceTo(c.target);
  }

  /** Wheel zoom (called by the input layer, which owns the wheel event). */
  zoom(deltaY: number) {
    const c = this.controls;
    this.targetDist = THREE.MathUtils.clamp(this.targetDist * Math.exp(deltaY * 0.0012), c.minDistance, c.maxDistance);
  }

  addShake(amount: number) {
    this.shake = Math.min(2.5, this.shake + amount);
  }

  setCinematic(on: boolean) {
    this.cinematic = on;
    this.controls.autoRotate = on;
  }

  update(dt: number) {
    const c = this.controls;
    const cam = this.camera;
    // remove last frame's shake before the controls read the camera
    cam.position.sub(this.shakeOffset);
    this.shakeOffset.set(0, 0, 0);

    if (this.cinematic) {
      this.cineT += dt;
      this.targetDist = 150 + Math.sin(this.cineT * 0.11) * 45;
      const desiredTarget = new THREE.Vector3(64, 30 + Math.sin(this.cineT * 0.07) * 4, 64);
      c.target.lerp(desiredTarget, dt * 0.3);
    }

    // smooth zoom: move along the view ray toward the wanted distance
    const offset = cam.position.clone().sub(c.target);
    const dist = offset.length();
    const nd = dist + (this.targetDist - dist) * Math.min(1, dt * 8);
    offset.setLength(nd);
    cam.position.copy(c.target).add(offset);

    // keep the orbit target near the island
    c.target.x = THREE.MathUtils.clamp(c.target.x, -20, SX + 20);
    c.target.y = THREE.MathUtils.clamp(c.target.y, -10, SY + 10);
    c.target.z = THREE.MathUtils.clamp(c.target.z, -20, SZ + 20);
    c.update(dt);
    // pinch-zoom on touch changes the distance inside the controls: adopt it
    const after = cam.position.distanceTo(c.target);
    if (Math.abs(after - nd) > 0.05) this.targetDist = after;

    // anti-clip: if the camera would be inside voxels, push it back toward/out along the view ray
    const p = cam.position;
    if (this.isBlocked(p)) {
      const dir = p.clone().sub(c.target).normalize();
      for (let k = 0; k < 60 && this.isBlocked(p); k++) p.addScaledVector(dir, 1);
      this.targetDist = Math.max(this.targetDist, p.distanceTo(c.target));
    }

    if (this.shake > 0.001) {
      const s = this.shake * this.shake;
      this.shakeOffset.set((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
      cam.position.add(this.shakeOffset);
      this.shake *= Math.exp(-dt * 6);
    }
  }

  private isBlocked(p: THREE.Vector3) {
    for (const [dx, dy, dz] of [[0, 0, 0], [0.8, 0, 0], [-0.8, 0, 0], [0, 0.8, 0], [0, -0.8, 0], [0, 0, 0.8], [0, 0, -0.8]]) {
      if (this.solidAt(Math.floor(p.x + dx), Math.floor(p.y + dy), Math.floor(p.z + dz))) return true;
    }
    return false;
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
