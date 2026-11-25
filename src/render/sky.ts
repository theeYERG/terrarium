// Sky dome, sun + moon, stars, cloud sea, fog and the day/night lighting rig.

import * as THREE from 'three';

const SKY_R = 900;

function lerpColor(a: THREE.Color, b: THREE.Color, t: number) {
  return a.clone().lerp(b, Math.min(1, Math.max(0, t)));
}
function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const C = (h: number) => new THREE.Color(h);
const DAY_TOP = C(0x6fa8e6), DAY_HOR = C(0xf4dcc8);
const SET_TOP = C(0x6a6aa8), SET_HOR = C(0xf7a98a);
const NIGHT_TOP = C(0x0b1030), NIGHT_HOR = C(0x2a2f5a);

export class SkyRig {
  group = new THREE.Group();
  sun = new THREE.DirectionalLight(0xffffff, 3);
  hemi = new THREE.HemisphereLight(0xbfdcff, 0x5a4a3a, 0.7);
  /** soft bounce light from the cloud sea below / opposite the sun (no shadows) */
  fill = new THREE.DirectionalLight(0xc8d8ff, 1);
  time = 0.34; // 0..1, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset
  dayLength = 360; // seconds per full cycle
  running = true;
  dayFactor = 1;
  sunDir = new THREE.Vector3();
  private skyMat: THREE.ShaderMaterial;
  private sky: THREE.Mesh;
  private stars: THREE.Points;
  private starMat: THREE.ShaderMaterial;
  private clouds: THREE.Sprite[] = [];
  private center: THREE.Vector3;
  fogColor = new THREE.Color();

  constructor(scene: THREE.Scene, center: THREE.Vector3) {
    this.center = center.clone();
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHor: { value: new THREE.Color() },
        uBot: { value: new THREE.Color() },
        uSun: { value: new THREE.Vector3() },
        uMoon: { value: new THREE.Vector3() },
        uSunCol: { value: new THREE.Color() },
        uNight: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop, uHor, uBot, uSun, uMoon, uSunCol;
        uniform float uNight;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float y = d.y;
          vec3 col = y > 0.0 ? mix(uHor, uTop, pow(clamp(y, 0.0, 1.0), 0.55)) : mix(uHor, uBot, pow(clamp(-y, 0.0, 1.0), 0.4));
          float sd = dot(d, uSun);
          col += uSunCol * (pow(max(sd, 0.0), 8.0) * 0.25 + pow(max(sd, 0.0), 120.0) * 0.8);
          col += uSunCol * smoothstep(0.9993, 0.9996, sd) * 6.0;
          float md = dot(d, uMoon);
          float moon = smoothstep(0.9992, 0.9995, md);
          col += vec3(0.75, 0.8, 0.95) * (moon * 1.4 + pow(max(md, 0.0), 300.0) * 0.25) * uNight;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 32, 16), this.skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.group.add(this.sky);

    // stars
    const n = 1800;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      pos[i * 3] = Math.cos(a) * r * (SKY_R - 20);
      pos[i * 3 + 1] = Math.abs(u) * (SKY_R - 20) * 0.9 + 30;
      pos[i * 3 + 2] = Math.sin(a) * r * (SKY_R - 20);
      seed[i] = Math.random();
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.starMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
      uniforms: { uNight: { value: 0 }, uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        varying float vA;
        uniform float uTime;
        void main() {
          vA = (0.5 + 0.5 * sin(uTime * (1.0 + aSeed * 3.0) + aSeed * 60.0)) * (0.4 + aSeed * 0.6);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = 1.2 + aSeed * aSeed * 2.6;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(c));
          gl_FragColor = vec4(vec3(0.85, 0.9, 1.0), a * vA * uNight);
        }`,
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    this.group.add(this.stars);

    // cloud sea under (and around) the island
    const cloudTex = makeCloudTexture();
    for (let i = 0; i < 44; i++) {
      const mat = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0.85, fog: true });
      const s = new THREE.Sprite(mat);
      const ring = i < 30;
      const a = Math.random() * Math.PI * 2;
      const r = ring ? 40 + Math.random() * 240 : 200 + Math.random() * 140;
      s.position.set(center.x + Math.cos(a) * r, ring ? -45 - Math.random() * 35 : 20 + Math.random() * 50, center.z + Math.sin(a) * r);
      const size = ring ? 70 + Math.random() * 90 : 50 + Math.random() * 50;
      s.scale.set(size, size * 0.55, 1);
      s.userData.speed = 0.6 + Math.random() * 1.2;
      s.userData.baseOpacity = ring ? 0.6 : 0.4;
      this.clouds.push(s);
      this.group.add(s);
    }

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -80; sc.right = 80; sc.top = 80; sc.bottom = -80; sc.near = 1; sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.sun.shadow.radius = 3;
    this.sun.target.position.copy(center);
    this.fill.target.position.copy(center);
    scene.add(this.sun, this.sun.target, this.hemi, this.fill, this.fill.target, this.group);
    scene.fog = new THREE.Fog(0xbfe2f2, 220, 700);
  }

  update(dt: number, camera: THREE.Camera, elapsed: number) {
    if (this.running) this.time = (this.time + dt / this.dayLength) % 1;
    const th = (this.time - 0.25) * Math.PI * 2;
    const sunDir = this.sunDir.set(Math.cos(th) * 0.85, Math.sin(th), 0.42).normalize();
    const moonDir = sunDir.clone().multiplyScalar(-1);
    const elev = sunDir.y;
    const day = smooth(-0.15, 0.22, elev);
    const dusk = Math.max(0, 1 - Math.abs(elev) / 0.32) * smooth(-0.3, 0.0, elev);
    this.dayFactor = day;

    const top = lerpColor(lerpColor(NIGHT_TOP, DAY_TOP, day), SET_TOP, dusk * 0.6);
    const hor = lerpColor(lerpColor(NIGHT_HOR, DAY_HOR, day), SET_HOR, dusk * 0.85);
    const bot = lerpColor(lerpColor(hor, top, 0.75), C(0x9fb8e8), 0.35 * day);
    const sunCol = lerpColor(C(0xffb070), C(0xfff2dc), smooth(0.0, 0.4, elev));
    const u = this.skyMat.uniforms;
    u.uTop.value.copy(top);
    u.uHor.value.copy(hor);
    u.uBot.value.copy(bot);
    u.uSun.value.copy(sunDir);
    u.uMoon.value.copy(moonDir);
    u.uSunCol.value.copy(sunCol).multiplyScalar(day * 0.8 + 0.05);
    u.uNight.value = 1 - day;
    this.starMat.uniforms.uNight.value = Math.pow(1 - day, 1.5) * 1.3;
    this.starMat.uniforms.uTime.value = elapsed;

    // key light follows the sun by day and the moon by night
    const useSun = elev > -0.06;
    const dir = useSun ? sunDir : moonDir;
    const fade = useSun ? smooth(-0.06, 0.08, elev) : smooth(-0.06, -0.2, elev);
    this.sun.position.copy(this.center).addScaledVector(dir, 200);
    this.sun.target.position.copy(this.center);
    if (useSun) {
      this.sun.color.copy(sunCol);
      this.sun.intensity = 2.9 * fade;
    } else {
      this.sun.color.set(0xa8bcff);
      this.sun.intensity = 1.2 * fade;
    }
    this.hemi.color.copy(lerpColor(C(0x34406e), C(0xcfe2ff), day));
    this.hemi.groundColor.copy(lerpColor(C(0x1c1e30), C(0xb3a597), day)); // warm bounce light
    this.hemi.intensity = 0.75 + 0.75 * day;
    this.fill.position.copy(this.center).add(new THREE.Vector3(-sunDir.x * 120, -90, -sunDir.z * 120));
    this.fill.intensity = 0.25 + 0.75 * day;
    this.fill.color.copy(lerpColor(C(0x6070a0), C(0xd2defa), day));

    this.fogColor.copy(hor);
    const fog = (camera.parent as THREE.Scene | null)?.fog as THREE.Fog | undefined;
    void fog;
    this.sky.position.copy(camera.position);
    this.stars.position.copy(camera.position);

    for (const s of this.clouds) {
      s.position.x += s.userData.speed * dt;
      if (s.position.x > this.center.x + 260) s.position.x -= 520;
      const m = s.material as THREE.SpriteMaterial;
      m.color.copy(lerpColor(lerpColor(C(0x2a3350), C(0xffffff), day), C(0xffc8a0), dusk * 0.7));
      m.opacity = s.userData.baseOpacity * (0.55 + 0.45 * day);
    }
  }
}

function makeCloudTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 22; i++) {
    const x = 24 + Math.random() * 80, y = 56 + Math.random() * 22 - (Math.abs(x - 64) < 25 ? 10 : 0), r = 12 + Math.random() * 22;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
