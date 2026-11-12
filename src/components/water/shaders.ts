import { foamFragment } from './foam'
import { iceMaskChunk, iceSurfaceChunk } from './ice'

export const oceanVertex = /* glsl */`
uniform sampler2D uDisplacement0,uDisplacement1,uDisplacement2;
uniform float uTexelOffset;
uniform mat4 textureMatrix;
varying vec3 vWorld;
varying vec2 vOceanUV;
varying vec4 vMirror;
varying float vViewDepth;
${iceMaskChunk}
void main(){
  vec4 world=modelMatrix*vec4(position,1.);
  vOceanUV=world.xz;
  vec3 displacement=texture2D(uDisplacement0,world.xz/256.+uTexelOffset).xyz
    +texture2D(uDisplacement1,world.xz/32.+uTexelOffset).xyz+texture2D(uDisplacement2,world.xz/4.+uTexelOffset).xyz;
  // 冻结的水面是静止的：冰层范围内的涌浪被压制。
  float ice=iceCoverage(world.xz);
  displacement*=(1.-ice);
  world.xyz+=displacement;
  vWorld=world.xyz;
  // Reflector 包含模型矩阵；平面的局部 Y 轴对应世界坐标的 -Z。
  vMirror=textureMatrix*vec4(position+vec3(displacement.x,-displacement.z,displacement.y),1.);
  vec4 mvPosition=viewMatrix*world;
  vViewDepth=-mvPosition.z;
  gl_Position=projectionMatrix*mvPosition;
}`

export const oceanFragment = /* glsl */`
uniform sampler2D tDiffuse,uRefraction,uDepth,uFoam;
uniform sampler2D uReflectionDepth;
uniform samplerCube uSkyEnvironment;
uniform sampler2D uNormal0,uNormal1,uNormal2;
uniform float uTime,uWind,uTexelOffset;
uniform vec2 uResolution;
uniform vec3 uEye,uSun,uSunColor,uWaterColor,uFogColor;
uniform float uFog,uDaylight,uNear,uFar;
uniform vec3 uBoat;
uniform float uBoatSpeed;
uniform float uRain,uOvercast,uFlash;
varying vec3 vWorld;
varying vec2 vOceanUV;
varying vec4 vMirror;
varying float vViewDepth;
#include <common>
#include <packing>
${foamFragment}
${iceMaskChunk}
${iceSurfaceChunk}
void main(){
  float dist=distance(uEye,vWorld);
  vec4 n0=texture2D(uNormal0,vOceanUV/256.+uTexelOffset);
  vec4 n1=texture2D(uNormal1,vOceanUV/32.+uTexelOffset);
  vec4 n2=texture2D(uNormal2,vOceanUV/4.+uTexelOffset,1.);
  vec2 slope=n0.xz/max(n0.y,.25)+n1.xz/max(n1.y,.25)*exp(-dist*.0004)
    +n2.xz/max(n2.y,.25)*exp(-dist*.0015);
  vec3 normal=normalize(vec3(slope.x,1.,slope.y));
  vec3 viewDir=normalize(uEye-vWorld);
  bool underwater=uEye.y<vWorld.y-.12;
  if(underwater)normal=-normal;
  vec2 screenUV=gl_FragCoord.xy/uResolution;
  float sceneDepth=-perspectiveDepthToViewZ(texture2D(uDepth,screenUV).x,uNear,uFar);
  float thickness=max(sceneDepth-vViewDepth,0.);
  vec2 distortion=normal.xz*min(thickness*.0015,.025);
  vec2 refractUV=clamp(screenUV+distortion,.002,.998);
  float distortedDepth=-perspectiveDepthToViewZ(texture2D(uDepth,refractUV).x,uNear,uFar);
  if(distortedDepth<vViewDepth)refractUV=screenUV;
  vec3 refraction=texture2D(uRefraction,refractUV).rgb;
  vec3 absorption=exp(-vec3(.29,.065,.045)*thickness);
  vec3 scatter=uWaterColor*(.12+uDaylight*.7);
  scatter=mix(scatter,uWaterColor*vec3(.25,.32,.5)*(.1+.9*uDaylight),smoothstep(10.,65.,thickness));
  vec3 water=refraction*absorption+scatter*(1.-absorption);
  vec3 reflectionPerturbation=mat3(viewMatrix)*(normal-vec3(0.,1.,0.));
  vec2 reflectionUV=vMirror.xy/vMirror.w+reflectionPerturbation.xy*(.035+.18/max(dist,8.));
  vec2 mirrorUV=clamp(reflectionUV,.001,.999);
  vec3 planarReflection=texture2D(tDiffuse,mirrorUV).rgb*.82;
  float reflectionDepth=texture2D(uReflectionDepth,mirrorUV).r;
  float objectReflection=1.-smoothstep(.9994,.99995,reflectionDepth);
  vec3 reflectionDirection=reflect(-viewDir,normal);
  vec3 skyReflection=textureCube(uSkyEnvironment,reflectionDirection).rgb;
  // 指向地平线以下的光线会打到邻近的波面，而不是明亮的天空。
  skyReflection=mix(uWaterColor*(.08+.2*uDaylight),skyReflection,smoothstep(-.12,.12,reflectionDirection.y));
  vec3 reflected=mix(skyReflection,planarReflection,objectReflection);
  float facing=clamp(dot(viewDir,normal),0.,1.);
  float fresnel=(.0204+.9796*pow(1.-facing,5.))*smoothstep(0.,.18,dot(viewDir,normal));
  // 在明亮的浅水里仍保留船体发暗、破碎的倒影。
  float reflectionWeight=max(fresnel,objectReflection*.48*exp(-dist*.002));
  vec3 color=mix(water,reflected,reflectionWeight);
  // 有限粗糙度的 GGX 太阳高光。
  vec3 halfDir=normalize(viewDir+uSun);
  float ndh=max(dot(normal,halfDir),0.), ndl=max(dot(normal,uSun),0.);
  float roughness=.18+min(uWind/30.,1.)*.05;
  float a2=pow(roughness,4.);
  float distribution=a2/(3.14159265*pow(ndh*ndh*(a2-1.)+1.,2.));
  float sunF=.0204+.9796*pow(1.-max(dot(viewDir,halfDir),0.),5.);
  float geometry=min(1.,min(2.*ndh*facing/max(dot(viewDir,halfDir),.001),2.*ndh*ndl/max(dot(viewDir,halfDir),.001)));
  color+=uSunColor*min(distribution*sunF*geometry/(4.*max(facing,.08)),6.)*uDaylight*.55*(1.-uRain*.65);
  float backlight=pow(max(dot(viewDir,-uSun),0.),4.);
  float crest=max(vWorld.y+.15,0.);
  color+=vec3(.008,.16,.13)*backlight*crest*uDaylight*(1.-facing);
  float shore=(1.-smoothstep(.0,1.15,thickness))*smoothstep(.04,.25,thickness);
  float breaking=clamp(n0.a+n1.a*.22,0.,1.);
  vec2 delta=vWorld.xz-uBoat.xz;
  float c=cos(uBoat.y),s=sin(uBoat.y);
  vec2 boatUV=vec2(c*delta.x-s*delta.y,s*delta.x+c*delta.y);
  float trail=smoothstep(2.,7.,-boatUV.x)*(1.-smoothstep(15.,65.,-boatUV.x));
  float wake=exp(-pow((abs(boatUV.y)-max(-boatUV.x,0.)*.17)*.9,2.))*trail*min(uBoatSpeed*.3,1.);
  // 岸线/水深交界跟随真实船体，不在船身周围画解析的圆环。
  float foam=foamCoverage(vOceanUV,breaking,shore,wake);
  vec3 foamColor=vec3(.82,.9,.91)*(.12+uDaylight*.88);
  color=mix(color,foamColor,foam);
  // 阴天把漫射光压成灰色，下雨则让海面更灰。
  float grey=dot(color,vec3(.299,.587,.114));
  color=mix(color,vec3(grey)*vec3(.8,.86,.95),clamp(uOvercast*.55+uRain*.18,0.,.7));
  color+=uFlash*vec3(.1,.13,.2);
  if(underwater){
    // 斯涅尔窗：水 -> 空气的临界角为 48.6 度。
    // 旧阈值在掠射角就露出天空，形成一层青色的天花板。
    float sinTransmitted2=1.333*1.333*(1.-facing*facing);
    float totalReflection=smoothstep(.96,1.02,sinTransmitted2);
    vec3 transmittedDirection=refract(-viewDir,normal,1.333);
    vec3 skyThroughWater=textureCube(uSkyEnvironment,normalize(transmittedDirection+vec3(0.,.0001,0.))).rgb;
    float geometryInRefraction=1.-smoothstep(uFar*.94,uFar*.99,distortedDepth);
    vec3 transmitted=mix(skyThroughWater,refraction,geometryInRefraction);
    vec3 internalReflection=vec3(.008,.105,.135)*(.035+.965*uDaylight);
    internalReflection*=.72+.28*normal.y*normal.y;
    float internalFresnel=.0204+.9796*pow(1.-facing,5.);
    color=mix(transmitted,internalReflection,max(totalReflection,internalFresnel));
    vec3 refractedSun=-refract(-uSun,vec3(0.,1.,0.),1./1.333);
    float sunWindow=pow(max(dot(-viewDir,refractedSun),0.),96.);
    color+=uSunColor*sunWindow*.75*(1.-totalReflection);
  }
  // 冰面在推进的锋面内取代海面。
  float ice=iceCoverage(vWorld.xz);
  if(ice>.002){
    vec3 iceColor=iceSurface(vWorld.xz,normalize(uEye-vWorld).xz*.06);
    // 掠射光泽，让冰面看起来是实心冰而不是贴片。刻意压得很低，
    // 否则会把远处冰面刷白、把裂缝图案洗掉。
    iceColor+=vec3(.055,.07,.085)*pow(1.-facing,3.);
    color=mix(color,iceColor,ice);
  }
  color=mix(color,uFogColor,1.-exp(-pow(dist*uFog,1.3)));
  gl_FragColor=vec4(color,1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`
