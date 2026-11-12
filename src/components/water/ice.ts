import * as THREE from 'three'

/** 冻结锋面：海洋顶点着色器（负责压平波浪）与表面着色器（负责切换冰面材质）共用。
 * 锋面边缘带低频抖动，让冰面向海岛四周推进时像冻结的潮水，
 * 而不是一个规整的圆。 */
export const iceMaskChunk = /* glsl */`
uniform vec2 uIceCenter;
uniform float uIceRadius;
float iceCoverage(vec2 p){
  if(uIceRadius<=.01)return 0.;
  vec2 d=p-uIceCenter;
  float angle=atan(d.y,d.x);
  float wobble=(sin(angle*3.1+1.7)*.09+sin(angle*7.3+.4)*.05+sin(angle*13.7)*.03)*uIceRadius;
  float front=uIceRadius+wobble;
  return 1.-smoothstep(front-3.5,front+1.5,length(d));
}
`

/** 冰面着色。
 *
 * 冰层是封闭的：参考用的裂缝贴图只提供发丝级的裂痕，
 * 绝不会挖出开口。这里取贴图最暗的芯部（iceCrease），在几个视差偏移上取并集，
 * 于是裂缝保有纵深，却永远不会张成一条宽带。
 * 每条裂缝显示得多深由低频噪声决定，
 * 这正是深裂与霜白愈合交替出现的来源。
 *
 * 贴图每几米就重复一次，220 m 的冰面必然暴露这一点，所以先对世界坐标
 * 做几米幅度的低频扭曲，再混入一层尺寸与旋转都不同的
 * 第二张网格。 */
export const iceSurfaceChunk = /* glsl */`
uniform sampler2D uIceCracks;
uniform sampler2D uIcePerlin;
mat2 iceRotate(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
/** 裂缝的发丝芯部：冰盘上为 0，只有最暗的缝心为 1。 */
float iceCrease(vec2 uv){
  return smoothstep(.2,.44,1.-texture2D(uIceCracks,uv).r);
}
vec3 iceSurface(vec2 p,vec2 parallax){
  // 采样前先打乱格子：扭曲幅度有数米，冰面上既找不出贴图边界，
  // 也看不出重复的图案。
  float w1=texture2D(uIcePerlin,p*.0087).r;
  float w2=texture2D(uIcePerlin,p*.0113+vec2(.37,.62)).r;
  vec2 q=p+(vec2(w1,w2)-.5)*7.;

  // 每张贴图对应 12 m 冰面：图里的发丝线约占图宽的 1.5%，
  // 落在地面上就是 15-20 cm，足以在远处的 mip 下存活，
  // 又远不至于被看成一条开口。
  const float TILE=12.;
  vec2 uv=q/TILE;
  vec2 travel=parallax/TILE*1.4;

  float perlin=texture2D(uIcePerlin,q*.021).r;
  float perlin2=texture2D(uIcePerlin,q*.09+vec2(.21,.66)).r;
  float frost=texture2D(uIcePerlin,q*.0053+vec2(.61,.07)).r;
  float zone=texture2D(uIcePerlin,q*.0117+vec2(.73,.19)).r;

  // 几层视差取并集：裂缝在纵深上叠加，而每一层都还是发丝线，
  // 所以永远不会有地方张开成宽缝。
  float crease=iceCrease(uv);
  for(int i=1;i<5;i++)crease=max(crease,iceCrease(uv+travel*float(i)*.5));
  // 第二层网格旋转过、尺寸也不同，两套格子永远对不齐。
  crease=max(crease,iceCrease(iceRotate(.9)*q/26.+vec2(.31,.74))*.75);
  // 区域疏密：有的地方几乎完整，有的地方裂得很密。
  crease*=.68+.32*smoothstep(.34,.62,zone);
  crease=pow(clamp(crease,0.,1.),1.6);

  // 裂缝深浅交替：深裂旁边紧挨着重新冻结的发白细缝。
  // 两个尺度叠加，海湾大范围与近处都能看出变化。
  // Perlin 噪声集中在中段，所以先把区间拉伸到满对比度，
  // 否则每条裂缝都会是同一个灰色。
  float tone=texture2D(uIcePerlin,q*.0075+vec2(.41,.12)).r*.65
            +texture2D(uIcePerlin,q*.031+vec2(.07,.83)).r*.35;
  float deep=smoothstep(.34,.68,tone);
  // 霜层让冰在局部变厚：积雪处发白，
  // 冰薄的区域更透、偏蓝灰。
  vec3 plate=mix(vec3(.18,.27,.33),vec3(.72,.78,.8),smoothstep(.38,.62,frost*.6+perlin*.4));
  plate*=.92+.12*perlin2;
  vec3 creaseColor=mix(vec3(.46,.54,.56),vec3(.01,.04,.06),deep);
  vec3 color=mix(plate,creaseColor,clamp(crease*1.35,0.,1.)*(.35+.65*deep));
  // 浅的那部分表现为重新冻结的发白细线，而不是黑色的切口。
  color=mix(color,vec3(.93,.96,.97),crease*(1.-deep)*.85);
  // 重新冻结的雪泥和风吹实的积雪压在冰盘之上。
  color=mix(color,vec3(.8,.86,.88),smoothstep(.6,.9,frost)*.22);
  // 细微起伏，避免冰面像一层平涂的颜料。
  color*=.9+.14*perlin2;
  return color;
}
`

export interface IceMaps {
  cracks: THREE.Texture
  perlin: THREE.Texture
}

/** 参考贴图的本地副本，存放在 public/water/textures。 */
export async function loadIceMaps(): Promise<IceMaps> {
  const loader = new THREE.TextureLoader()
  const [cracks, perlin] = await Promise.all([
    loader.loadAsync('/water/textures/cracks.png'),
    loader.loadAsync('/water/textures/smokeMap.png'),
  ])
  for (const texture of [cracks, perlin]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.colorSpace = THREE.NoColorSpace
    // 掠射视角会把冰面一直拉到地平线，各向异性过滤
    // 能防止远处的裂缝糊成一片。
    texture.anisotropy = 4
    texture.needsUpdate = true
  }
  return { cracks, perlin }
}
