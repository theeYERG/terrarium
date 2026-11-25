// 3D brush preview: a glowing rim sphere showing the brush volume plus a highlight on the
// exact voxel face under the cursor.

import * as THREE from 'three';

export class BrushPreview {
  group = new THREE.Group();
  private sphere: THREE.Mesh;
  private face: THREE.Mesh;
  private faceEdge: THREE.LineSegments;
  private mat: THREE.ShaderMaterial;
  private faceMat: THREE.MeshBasicMaterial;
  private targetPos = new THREE.Vector3();
  private targetScale = 1;
  private visible = false;
  private alpha = 0;

  constructor(scene: THREE.Scene) {
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(0xffffff) }, uTime: { value: 0 }, uAlpha: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() {
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vV = normalize(-mv.xyz);
          vP = position;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uTime; uniform float uAlpha;
        varying vec3 vN; varying vec3 vV; varying vec3 vP;
        void main() {
          float rim = pow(1.0 - abs(dot(vN, vV)), 2.2);
          float lat = abs(fract(vP.y * 4.0 + uTime * 0.4) - 0.5);
          float lines = smoothstep(0.06, 0.0, lat) * 0.35;
          float a = (0.06 + rim * 0.75 + lines * rim) * uAlpha;
          gl_FragColor = vec4(uColor * (1.2 + rim), a);
        }`,
      side: THREE.DoubleSide,
    });
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), this.mat);
    this.sphere.renderOrder = 10;
    this.faceMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
    this.face = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.faceMat);
    this.face.renderOrder = 11;
    const edges = new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1));
    this.faceEdge = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
    this.faceEdge.renderOrder = 12;
    this.face.add(this.faceEdge);
    this.group.add(this.sphere, this.face);
    this.group.visible = false;
    scene.add(this.group);
  }

  show(hit: { x: number; y: number; z: number; nx: number; ny: number; nz: number } | null, radius: number, color: THREE.Color, onSurface: boolean) {
    this.visible = !!hit;
    if (!hit) return;
    // centre: on the face for "add" tools, in the hit voxel for removing tools
    const c = new THREE.Vector3(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    if (onSurface) c.add(new THREE.Vector3(hit.nx, hit.ny, hit.nz).multiplyScalar(Math.max(1, radius)));
    this.targetPos.copy(c);
    this.targetScale = Math.max(0.6, radius + 0.5);
    this.mat.uniforms.uColor.value.copy(color);
    this.faceMat.color.copy(color);
    (this.faceEdge.material as THREE.LineBasicMaterial).color.copy(color);
    // face quad
    const f = this.face;
    f.position.set(hit.x + 0.5 + hit.nx * 0.51, hit.y + 0.5 + hit.ny * 0.51, hit.z + 0.5 + hit.nz * 0.51);
    f.lookAt(f.position.x + hit.nx, f.position.y + hit.ny, f.position.z + hit.nz);
  }

  update(dt: number, time: number) {
    this.alpha += ((this.visible ? 1 : 0) - this.alpha) * Math.min(1, dt * 14);
    this.group.visible = this.alpha > 0.02;
    this.mat.uniforms.uAlpha.value = this.alpha;
    this.mat.uniforms.uTime.value = time;
    this.faceMat.opacity = 0.3 * this.alpha;
    const s = this.sphere;
    if (s.position.lengthSq() === 0) s.position.copy(this.targetPos);
    s.position.lerp(this.targetPos, Math.min(1, dt * 25));
    const sc = s.scale.x + (this.targetScale - s.scale.x) * Math.min(1, dt * 15);
    s.scale.setScalar(sc);
  }
}
