import * as THREE from 'three'
import type { Quality } from './settings'

const counts: Record<Quality, number> = { Low: 3200, Medium: 5600, High: 8500, Ultra: 12000 }

/** 跟随相机的柔和雪花体积。它们横向漂移，下落得比雨慢得多，
 * 并在视图空间做面向相机的对齐，保证看起来始终是圆的。 */
const snowVertex = /* glsl */`
uniform float uTime,uIntensity,uDaylight;
uniform vec3 uEye;
uniform vec2 uArea;
attribute vec3 aOffset;
attribute vec4 aParams;
varying float vAlpha;
varying vec2 vSnowUv;
void main(){
  float fall=fract(aOffset.y-uTime*aParams.x*.03);
  float sway=sin(uTime*.6+aParams.w*21.)*1.2;
  vec3 world=vec3(
    uEye.x+aOffset.x*uArea.x+sway,
    uEye.y+mix(-8.,40.,fall),
    uEye.z+aOffset.z*uArea.y+sway*.7
  );
  vec4 mvPosition=viewMatrix*vec4(world,1.);
  mvPosition.xy+=position.xy*aParams.y;
  vSnowUv=uv;
  float edge=1.-smoothstep(.55,1.,length(aOffset.xz));
  float fade=smoothstep(0.,.06,fall)*(1.-smoothstep(.9,1.,fall));
  vAlpha=step(aParams.z,uIntensity)*edge*fade*(.5+.5*uDaylight);
  gl_Position=projectionMatrix*mvPosition;
}`

const snowFragment = /* glsl */`
varying float vAlpha;
varying vec2 vSnowUv;
void main(){
  float mask=smoothstep(.5,.08,length(vSnowUv-.5));
  float alpha=vAlpha*mask;
  if(alpha<.01)discard;
  gl_FragColor=vec4(vec3(.93,.96,1.),alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`

export class SnowSystem {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>
  private readonly material: THREE.ShaderMaterial
  private quality: Quality

  constructor(quality: Quality) {
    this.quality = quality
    this.material = new THREE.ShaderMaterial({
      vertexShader: snowVertex, fragmentShader: snowFragment,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 }, uIntensity: { value: 0 }, uDaylight: { value: 1 },
        uEye: { value: new THREE.Vector3() }, uArea: { value: new THREE.Vector2(44, 44) },
      },
    })
    this.mesh = new THREE.Mesh(this.build(quality), this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 6
    this.mesh.visible = false
  }

  private build(quality: Quality) {
    const count = counts[quality]
    const offsets = new Float32Array(count * 3)
    const params = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) {
      offsets[i * 3] = Math.random() * 2 - 1
      offsets[i * 3 + 1] = Math.random()
      offsets[i * 3 + 2] = Math.random() * 2 - 1
      params[i * 4] = 0.6 + Math.random() * 0.9 // 下落速度
      params[i * 4 + 1] = 0.05 + Math.random() * 0.09 // 雪花尺寸（米）
      params[i * 4 + 2] = Math.random() // 可见阈值
      params[i * 4 + 3] = Math.random() // 摆动相位
    }
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-.5, -.5, 0, .5, -.5, 0, .5, .5, 0, -.5, .5, 0]), 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2))
    geometry.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 3))
    geometry.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    geometry.instanceCount = count
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

const snowInjection = {
  vertexHead: '#include <common>',
  vertexCode: /* glsl */`
    varying vec3 vSnowWorld;
    varying vec3 vSnowNormal;
  `,
  vertexBody: /* glsl */`
    vSnowWorld=(modelMatrix*vec4(transformed,1.)).xyz;
    vSnowNormal=normalize(mat3(modelMatrix)*objectNormal);
  `,
  fragmentCode: /* glsl */`
    uniform float uSnow;
    varying vec3 vSnowWorld;
    varying vec3 vSnowNormal;
  `,
  fragmentBody: /* glsl */`
    {
      float up=clamp(vSnowNormal.y,0.,1.);
      // 朝上的面先变白且全白；竖直面只留一层薄薄的积雪。
      float cover=clamp(uSnow*(.82+.18*up),0.,1.);
      float cap=.55+.45*smoothstep(.0,.85,up);
      vec3 snowTint=vec3(.9,.93,.97)*(.6+.4*max(dot(vSnowNormal,normalize(vec3(.25,.9,.35))),0.));
      gl_FragColor.rgb=mix(gl_FragColor.rgb,snowTint,cover*cap);
    }
  `,
}

/** 把共享的积雪量灌入已经烘焙好光照的模型：
 * 只修补一次标准材质，之后仅更新一个 uniform。 */
export class SnowCover {
  private readonly uniform = { value: 0 }
  private readonly patched = new Set<THREE.Material>()

  get amount() { return this.uniform.value }
  set amount(value: number) { this.uniform.value = THREE.MathUtils.clamp(value, 0, 1) }

  add(root: THREE.Object3D) {
    root.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || !mesh.material) return
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        this.patch(material)
      }
    })
  }

  private patch(material: THREE.Material) {
    if (this.patched.has(material)) return
    const standard = material as THREE.MeshStandardMaterial
    if (!('isMeshStandardMaterial' in standard) || !standard.isMeshStandardMaterial) return
    this.patched.add(material)
    const uniform = this.uniform
    standard.onBeforeCompile = shader => {
      shader.uniforms.uSnow = uniform
      shader.vertexShader = shader.vertexShader
        .replace(snowInjection.vertexHead, `${snowInjection.vertexHead}\n${snowInjection.vertexCode}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${snowInjection.vertexBody}`)
      shader.fragmentShader = shader.fragmentShader
        .replace(snowInjection.vertexHead, `${snowInjection.vertexHead}\n${snowInjection.fragmentCode}`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${snowInjection.fragmentBody}`)
    }
    standard.needsUpdate = true
  }
}
