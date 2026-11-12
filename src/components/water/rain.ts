import * as THREE from 'three'
import type { Quality } from './settings'

const counts: Record<Quality, number> = { Low: 4200, Medium: 7000, High: 10000, Ultra: 14000 }

/** 跟随相机的实例化雨丝体积。密度由 uIntensity 驱动，而不是实例数量，
 * 所以拖动滑块永远不会重新分配缓冲。 */
const rainVertex = /* glsl */`
uniform float uTime,uIntensity,uDaylight,uSlant;
uniform vec3 uEye;
uniform vec2 uArea;
attribute vec3 aOffset;
attribute vec3 aParams;
varying float vAlpha;
void main(){
  // 时间取负使相位收缩，于是雨滴是往下落的，
  // 而不是从海里往上升。
  float fall=fract(aOffset.y-uTime*aParams.x*.3);
  vec3 world=vec3(
    uEye.x+aOffset.x*uArea.x+fall*uSlant,
    uEye.y+mix(-20.,42.,fall),
    uEye.z+aOffset.z*uArea.y+fall*uSlant*.35
  );
  vec3 toEye=uEye-world;
  // 只绕世界竖直轴做面向相机：雨丝始终是一根下落的柱子，
  // 这样垂直向下看时它真的会变短，而不是在海面上
  // 躺成一条白杠。
  vec3 right=normalize(cross(vec3(0.,1.,0.),toEye)+vec3(1e-4,0.,0.));
  float streak=aParams.y*mix(.18,.55,uIntensity);
  world+=right*position.x*.022+vec3(0.,position.y*streak,0.);
  float edge=1.-smoothstep(.6,1.,length(aOffset.xz));
  float fade=smoothstep(0.,.05,fall)*(1.-smoothstep(.92,1.,fall));
  // 紧贴镜头的水滴会被拉成巨型条纹。
  float nearFade=smoothstep(1.5,5.,distance(uEye,world));
  vAlpha=step(aParams.z,uIntensity)*edge*fade*nearFade*(.12+.3*uIntensity)*(.2+.8*uDaylight);
  gl_Position=projectionMatrix*viewMatrix*vec4(world,1.);
}`

const rainFragment = /* glsl */`
varying float vAlpha;
void main(){
  if(vAlpha<.004)discard;
  gl_FragColor=vec4(vec3(.38,.45,.55),vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

export class RainSystem {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>
  private readonly material: THREE.ShaderMaterial
  private quality: Quality

  constructor(quality: Quality) {
    this.quality = quality
    this.material = new THREE.ShaderMaterial({
      vertexShader: rainVertex, fragmentShader: rainFragment,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 }, uIntensity: { value: 0 }, uDaylight: { value: 1 }, uSlant: { value: 0 },
        uEye: { value: new THREE.Vector3() }, uArea: { value: new THREE.Vector2(46, 46) },
      },
    })
    this.mesh = new THREE.Mesh(this.build(quality), this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 5
    this.mesh.visible = false
  }

  private build(quality: Quality) {
    const count = counts[quality]
    const offsets = new Float32Array(count * 3)
    const params = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      offsets[i * 3] = Math.random() * 2 - 1
      offsets[i * 3 + 1] = Math.random()
      offsets[i * 3 + 2] = Math.random() * 2 - 1
      params[i * 3] = 0.55 + Math.random() * 0.95 // 下落速度
      params[i * 3 + 1] = 0.5 + Math.random() * 0.95 // 拖尾长度
      params[i * 3 + 2] = Math.random() // 可见阈值
    }
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-.5, -.5, 0, .5, -.5, 0, .5, .5, 0, -.5, .5, 0]), 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2))
    geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3))
    geometry.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 3))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    geometry.instanceCount = count
    // 雨丝完全在顶点着色器中位移。
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6)
    return geometry
  }

  setQuality(quality: Quality) {
    if (quality === this.quality) return
    this.quality = quality
    this.mesh.geometry.dispose()
    this.mesh.geometry = this.build(quality)
  }

  setIntensity(intensity: number) {
    this.material.uniforms.uIntensity.value = THREE.MathUtils.clamp(intensity, 0, 1)
    this.mesh.visible = intensity > 0.004
  }

  setWind(wind: number) {
    this.material.uniforms.uSlant.value = THREE.MathUtils.clamp(wind, 0, 30) * 0.13
  }

  update(time: number, camera: THREE.Camera, daylight: number) {
    this.material.uniforms.uTime.value = time
    this.material.uniforms.uDaylight.value = daylight
    this.material.uniforms.uEye.value.copy(camera.position)
  }

  dispose() {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}

/** 每一段都是一条朝向相机的飘带，使通道具有真实粗细，
 * 生成过程由一道扩张的波前逐步揭示。 */
const boltVertex = /* glsl */`
attribute float aBirth;
attribute float aHeight;
varying float vBirth;
varying float vHeight;
varying vec2 vBoltUv;
void main(){
  vBirth=aBirth;
  vHeight=aHeight;
  vBoltUv=uv;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);
}`

const boltFragment = /* glsl */`
uniform float uProgress,uIntensity;
varying float vBirth;
varying float vHeight;
varying vec2 vBoltUv;
void main(){
  if(vBirth>uProgress)discard;
  // 热芯沿飘带宽度逐渐过渡为柔和的外鞘。
  float across=1.-abs(vBoltUv.x*2.-1.);
  float channel=pow(across,2.5)*.85+pow(across,10.)*.75;
  // 通道顶部溶入云底，而不是在半空中
  // 以一条硬边突然结束。
  float cloud=1.-smoothstep(.5,.96,vHeight);
  gl_FragColor=vec4(vec3(.8,.87,1.),channel*cloud*uIntensity);
}`

interface BoltBuffer {
  positions: number[]
  uvs: number[]
  births: number[]
  heights: number[]
}

/** 每次落雷都会重建的云到海闪电，逐步揭示。 */
export class LightningSystem {
  readonly bolt: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  /** 指向落点的归一化世界方向，天空辉光与闪光灯共用。 */
  readonly strikeDirection = new THREE.Vector3(0, 0.4, -1).normalize()
  flash = 0
  private readonly material: THREE.ShaderMaterial
  private elapsed = -1
  private wait = 2.5

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: boltVertex, fragmentShader: boltFragment,
      transparent: true, depthWrite: false, depthTest: true, toneMapped: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { uProgress: { value: 0 }, uIntensity: { value: 0 } },
    })
    this.bolt = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    this.bolt.frustumCulled = false
    this.bolt.visible = false
    this.bolt.renderOrder = -5
  }

  update(delta: number, enabled: boolean, overcast: number, rain: number, camera: THREE.Camera): number {
    const stormy = enabled && (overcast > 0.18 || rain > 0.12)
    if (!stormy) {
      this.elapsed = -1
      this.flash = 0
      this.bolt.visible = false
      this.wait = 2.5
      return 0
    }
    if (this.elapsed < 0) {
      this.wait -= delta
      // 雨越密，落雷越频繁。
      if (this.wait <= 0) {
        this.elapsed = 0
        this.build(camera)
        this.wait = (3.5 + Math.random() * 8) * (1 - rain * 0.4)
      }
      this.flash *= Math.exp(-delta * 6)
      this.bolt.visible = false
      return this.flash
    }
    this.elapsed += delta
    const t = this.elapsed
    const progress = Math.min(1, t / 0.16)
    const primary = Math.exp(-Math.max(t - 0.05, 0) * 5.5) * (0.74 + 0.26 * Math.sin(t * 62))
    const secondary = t > 0.22 ? Math.exp(-(t - 0.22) * 7) * 0.7 : 0
    this.flash = THREE.MathUtils.clamp(Math.max(primary, secondary), 0, 1)
    this.material.uniforms.uProgress.value = progress
    this.material.uniforms.uIntensity.value = Math.min(1.25, this.flash * 1.35)
    this.bolt.visible = this.flash > 0.02
    if (t > 1.2) {
      this.elapsed = -1
      this.flash = 0
      this.bolt.visible = false
    }
    return this.flash
  }

  private build(camera: THREE.Camera) {
    // 保证落雷在视野内，否则一半的闪电会发生在
    // 观察者背后，永远看不到。
    const forward = camera.getWorldDirection(new THREE.Vector3())
    const angle = Math.atan2(forward.z, forward.x) + (Math.random() - 0.5) * 1.6
    const distance = 380 + Math.random() * 420
    const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle))
    this.strikeDirection.copy(direction).setY(0.4).normalize()
    const top = 300 + Math.random() * 320
    const buffer: BoltBuffer = { positions: [], uvs: [], births: [], heights: [] }
    const side = new THREE.Vector3()
    const axis = new THREE.Vector3()
    // 每段一条朝向相机的飘带，宽度足以在 800 m 外仍然可见。
    const ribbon = (from: THREE.Vector3, to: THREE.Vector3, width: number, birth: number) => {
      axis.subVectors(to, from)
      if (axis.lengthSq() < 1e-6) return
      side.crossVectors(axis, this.strikeDirection)
      if (side.lengthSq() < 1e-6) side.crossVectors(axis, new THREE.Vector3(0, 1, 0))
      side.normalize().multiplyScalar(width * 0.5)
      const ax = from.x - side.x, ay = from.y - side.y, az = from.z - side.z
      const bx = from.x + side.x, by = from.y + side.y, bz = from.z + side.z
      const cx = to.x + side.x, cy = to.y + side.y, cz = to.z + side.z
      const dx = to.x - side.x, dy = to.y - side.y, dz = to.z - side.z
      const fromHeight = Math.min(from.y / top, 1), toHeight = Math.min(to.y / top, 1)
      const quad = [[ax, ay, az, 0, 0], [bx, by, bz, 1, 0], [cx, cy, cz, 1, 1], [ax, ay, az, 0, 0], [cx, cy, cz, 1, 1], [dx, dy, dz, 0, 1]]
      for (const [x, y, z, u, v] of quad) {
        buffer.positions.push(x, y, z)
        buffer.uvs.push(u, v)
        buffer.births.push(birth)
        buffer.heights.push(v === 0 ? fromHeight : toHeight)
      }
    }
    // 从云底伸出的主干，加上沿途递归分叉。
    const grow = (start: THREE.Vector3, heading: THREE.Vector3, length: number, width: number, depth: number, birth: number) => {
      const points = [start.clone()]
      const steps = 7
      const step = length / steps
      const point = start.clone()
      const dir = heading.clone().normalize()
      for (let i = 0; i < steps; i++) {
        const jitter = 0.5 + depth * 0.25
        dir.x += (Math.random() - 0.5) * jitter
        dir.z += (Math.random() - 0.5) * jitter
        dir.normalize()
        const next = point.clone().addScaledVector(dir, step)
        next.y = Math.max(next.y, 5)
        ribbon(point, next, width, birth + i * 0.0022)
        point.copy(next)
        points.push(next.clone())
      }
      if (depth <= 0) return
      const forks = 2 + (Math.random() < 0.55 ? 1 : 0)
      for (let fork = 0; fork < forks; fork++) {
        const anchor = points[1 + Math.floor(Math.random() * (points.length - 2))]
        const outward = new THREE.Vector3((Math.random() - 0.5) * 1.5, -0.9, (Math.random() - 0.5) * 1.5)
        grow(anchor, outward, length * (0.3 + Math.random() * 0.3), width * 0.55, depth - 1, birth + 0.06 + Math.random() * 0.25)
      }
    }
    const origin = new THREE.Vector3(camera.position.x, top, camera.position.z).addScaledVector(direction, distance)
    grow(origin, new THREE.Vector3(0, -1, 0), top - 8, 7 * (0.7 + Math.random() * 0.6), 3, 0)
    this.bolt.geometry.dispose()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(buffer.positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(buffer.uvs, 2))
    geometry.setAttribute('aBirth', new THREE.Float32BufferAttribute(buffer.births, 1))
    geometry.setAttribute('aHeight', new THREE.Float32BufferAttribute(buffer.heights, 1))
    geometry.computeBoundingSphere()
    this.bolt.geometry = geometry
    this.material.uniforms.uProgress.value = 0
  }

  dispose() {
    this.bolt.geometry.dispose()
    this.material.dispose()
  }
}
