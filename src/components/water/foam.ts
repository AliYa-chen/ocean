/** 海洋材质与 GPU 覆盖度回归测试共用。 */
export const foamFragment = /* glsl */`
float foamCoverage(vec2 surfacePosition,float breaking,float shore,float wake){
  // 与泡沫历史图的风漂移保持一致：位移会随波浪拉伸气泡壁，
  // 而不是让一张独立的贴片横着滑过水面。
  vec2 foamPosition=surfacePosition-vec2(.94,.342)*uWind*.035*uTime;
  vec2 foamUV=vec2(dot(foamPosition,vec2(.94,.342)),dot(foamPosition,vec2(-.342,.94)));
  float filaments=texture2D(uFoam,foamUV*vec2(.055,.038)).r;
  float detail=texture2D(uFoam,mat2(.8,-.6,.6,.8)*foamUV*vec2(.17,.13)+.37).r;
  // 线性覆盖度在 mipmap 之前就已提取，远处的气泡壁会平均成一层淡淡的白纱。
  // 即使在最强的浪峰，也不要把这些空洞填满。
  // 只调制丝状结构、不额外叠加细节：被缩小的细节不能在
  // 本来透明的空洞里引入一层恒定的灰底。
  float pattern=filaments*mix(.85,1.,detail);
  float fresh=smoothstep(.5,.95,breaking);
  float residue=sqrt(clamp(breaking,0.,1.));
  float crest=(fresh*.24+residue*.5)*pattern;
  return clamp(crest+(shore+wake)*.5*pattern,0.,.78);
}
`
