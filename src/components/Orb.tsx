import { useEffect, useRef } from 'react';
import type { Mood } from '../lib/mood';
import { orbTarget, type OrbTarget } from '../lib/orb-state';

/**
 * The living Orb — a raymarched WebGL sphere that reflects what the agent is
 * doing. Colour, flow, turbulence, corona and core-pulse all ease toward a
 * per-phase target (see orb-state.ts), so idle breathes slow and blue, deep
 * reasoning churns magenta, a running command flares amber, an error goes red.
 *
 * The canvas fills its parent; size it with CSS. One WebGL context per mount —
 * keep the number of simultaneous Orbs small.
 */

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
uniform vec2 uRes; uniform float uTime; uniform vec2 uMouse;
uniform float uFlow, uTurb, uGlow, uStorm, uMotion, uTransparent;
uniform vec3 uA, uB, uC, uD;

vec3 pal(float t){ return uA + uB * cos(6.28318530718 * (uC * t + uD)); }
float hash(vec3 p){ p = fract(p*0.3183099 + vec3(0.11,0.17,0.23)); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float vnoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),
                 mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
                 mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p){ float s=0.0,a=0.5; for(int i=0;i<6;i++){ s+=a*vnoise(p); p=p*2.03+vec3(1.7,9.2,3.3); a*=0.5; } return s; }
float h11(float n){ return fract(sin(n*43758.5453123)*12345.6789); }

float coreFlashes(vec3 p, float t){
  float light = 0.0;
  for(int c=0;c<5;c++){
    float fc=float(c);
    vec3 cc=vec3(h11(fc+1.0),h11(fc+9.0),h11(fc+17.0))-0.5; cc*=1.15;
    cc+=0.16*vec3(sin(t*0.23+fc),cos(t*0.19+fc*2.1),sin(t*0.27+fc*3.3));
    float period=2.4+2.6*h11(fc+31.0); float phase=h11(fc+41.0)*12.0;
    float cyc=fract((t+phase)/period);
    float burst=exp(-cyc*7.0)*smoothstep(0.0,0.05,cyc);
    for(int s=0;s<4;s++){
      float fs=float(s);
      vec3 off=vec3(h11(fc*7.0+fs+2.0),h11(fc*7.0+fs+5.0),h11(fc*7.0+fs+8.0))-0.5;
      vec3 fp=cc+off*0.5;
      float lag=fract(cyc-fs*0.11);
      float spark=exp(-lag*16.0)*step(cyc,0.7);
      float d2=dot(p-fp,p-fp);
      light+=burst*spark/(1.0+d2*34.0);
    }
  }
  return light;
}
mat3 rotY(float a){ float c=cos(a),s=sin(a); return mat3(c,0.0,-s,0.0,1.0,0.0,s,0.0,c); }
mat3 rotX(float a){ float c=cos(a),s=sin(a); return mat3(1.0,0.0,0.0,0.0,c,-s,0.0,s,c); }
float field(vec3 sp, float tm){
  vec3 w=vec3(fbm(sp*1.6+vec3(0.0,0.0,tm*0.12)),fbm(sp*1.6+vec3(4.3,1.9,tm*0.10)),fbm(sp*1.6+vec3(7.7,8.1,tm*0.09)));
  vec3 q=sp*2.1+uTurb*2.3*(w-0.5)+vec3(0.0,0.0,tm*0.18);
  return fbm(q);
}
vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes) / uRes.y;
  float tm = uTime * mix(0.15, 1.0, uMotion);
  // A little further back than the reference so the sphere leaves a clear
  // margin inside its canvas — nothing to read as a box edge.
  vec3 ro = vec3(0.0,0.0,4.9);
  vec3 rd = normalize(vec3(uv, -2.2));
  float yaw = uMouse.x*2.4 + tm*0.06*uMotion;
  float pitch = uMouse.y*1.3 - 0.12;
  mat3 rot = rotX(pitch)*rotY(yaw);
  vec3 col = vec3(0.0);
  float b = dot(ro,rd);
  float c2 = dot(ro,ro) - 1.0;
  float h = b*b - c2;
  float closest = sqrt(max(dot(ro,ro)-b*b,0.0));
  float corona = exp(-(closest-1.0)*7.0) * step(1.0,closest);
  col += pal(0.35 + 0.15*sin(tm*0.3)) * corona * 0.8 * uGlow;
  if(h > 0.0){
    float t0 = -b - sqrt(h); float t1 = -b + sqrt(h); t0 = max(t0,0.0);
    vec3 acc = vec3(0.0); vec3 emis = vec3(0.0); float alpha = 0.0;
    const int STEPS = 26;
    for(int i=0;i<STEPS;i++){
      float fi = float(i)/float(STEPS-1);
      float tt = mix(t0,t1,fi);
      vec3 pos = ro + rd*tt; vec3 sp = rot*pos;
      float d = field(sp*1.15, tm*uFlow);
      d = pow(clamp(d,0.0,1.0),1.6);
      float shell = clamp(1.0 - abs(length(pos)-0.5)*1.05, 0.0, 1.0);
      float dens = smoothstep(0.24,0.95,d) * shell;
      float fl = coreFlashes(sp, tm*(0.6+0.7*uFlow)) * uStorm;
      vec3 c = pal(d*1.6 + tm*0.035 + length(sp)*0.25);
      c *= 0.7 + 1.3*d;
      c *= 1.0 + fl*3.5;
      acc += (1.0-alpha)*dens*c*0.5;
      alpha += (1.0-alpha)*dens*0.17;
      vec3 flashCol = pal(0.5 + 0.18*sin(tm*0.6) + d*0.3);
      emis += (1.0-alpha)*fl*flashCol*0.9*shell;
      if(alpha > 0.99) break;
    }
    vec3 n = normalize(ro + rd*t0);
    float fres = pow(1.0 - clamp(dot(n,-rd),0.0,1.0), 2.6);
    vec3 rim = vec3(pal(0.5+tm*0.05+0.02).r, pal(0.5+tm*0.05).g, pal(0.5+tm*0.05-0.02).b);
    acc += fres*rim*1.7;
    emis = emis / (1.0 + 0.7*emis);
    col = mix(col, acc, clamp(alpha + fres*0.5, 0.0, 1.0));
    col += emis*0.6;
  }
  col *= 1.15; col = aces(col); col = pow(col, vec3(0.92));
  float lum = dot(col, vec3(0.299,0.587,0.114));
  float g = hash(vec3(gl_FragCoord.xy, floor(uTime*24.0))) - 0.5;
  col += g*0.015*smoothstep(0.02,0.25,lum);
  col = max(col, 0.0);
  // Opaque in-app. On the transparent desktop overlay: the sphere's own disc
  // is fully solid (h>0 = the ray hit the unit sphere), a soft halo fades out
  // around it, and the rest of the canvas is gone entirely — no box, no
  // see-through orb.
  float disc = smoothstep(-0.04, 0.06, h);
  float halo = corona * uGlow * 0.9;
  float a = mix(1.0, clamp(disc + halo, 0.0, 1.0), uTransparent);
  gl_FragColor = vec4(col * a, a);   // premultiplied
}
`;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function lerp3(a: number[], b: readonly number[], t: number): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function Orb({
  mood,
  className,
  interactive = false,
  transparent = false,
}: {
  mood: Mood;
  className?: string;
  interactive?: boolean;
  /** For the desktop overlay: the void becomes see-through, only the orb shows. */
  transparent?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const transparentRef = useRef(transparent);
  transparentRef.current = transparent;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
    });
    if (!gl) return;

    const reduceMotion = matchMedia('(prefers-reduced-motion:reduce)').matches;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('[orb]', gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const prog = gl.createProgram()!;
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const U: Record<string, WebGLUniformLocation | null> = {};
    ['uRes', 'uTime', 'uMouse', 'uFlow', 'uTurb', 'uGlow', 'uStorm', 'uA', 'uB', 'uC', 'uD', 'uMotion', 'uTransparent'].forEach(
      (n) => (U[n] = gl.getUniformLocation(prog, n))
    );
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied

    // live, eased state
    const init = orbTarget('idle');
    const cur: OrbTarget = JSON.parse(JSON.stringify(init));
    const mouse = [0, 0];
    const target = [0, 0];

    let dpr = 1;
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    let dragging = false;
    let px = 0;
    let py = 0;
    const onDown = (e: PointerEvent) => {
      if (!interactive) return;
      dragging = true;
      px = e.clientX;
      py = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      target[0] += ((e.clientX - px) / window.innerWidth) * 2.4;
      target[1] = Math.max(-1.1, Math.min(1.1, target[1] + ((e.clientY - py) / window.innerHeight) * 2.4));
      px = e.clientX;
      py = e.clientY;
    };
    const onUp = () => (dragging = false);
    if (interactive) {
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
    }

    let visible = true;
    const io = new IntersectionObserver((entries) => (visible = entries[0]?.isIntersecting ?? true), {
      threshold: 0,
    });
    io.observe(canvas);

    const motion = reduceMotion ? 0.12 : 1.0;
    const startedAt = performance.now();
    let raf = 0;
    let lastFrame = 0;

    const frame = (nowMs: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible || document.hidden) return;
      // ~40fps cap — the orb never needs 60, and it may share the GPU.
      if (nowMs - lastFrame < 24) return;
      lastFrame = nowMs;

      const m = moodRef.current;
      const tgt = orbTarget(m.phase);
      // Effort within a phase nudges flow/turb/storm without changing hue.
      const speedK = 0.7 + 0.5 * Math.min(Math.max(m.speed, 0), 2);
      const intK = 0.7 + 0.6 * Math.min(Math.max(m.intensity, 0), 1);
      const wantFlow = tgt.flow * speedK;
      const wantTurb = tgt.turb * (0.75 + 0.4 * intK);
      const wantGlow = tgt.glow * (0.85 + 0.25 * intK);
      const wantStorm = tgt.storm * intK;

      const k = 0.045; // easing per frame → ~0.6s to settle
      cur.a = lerp3(cur.a, tgt.a, k);
      cur.b = lerp3(cur.b, tgt.b, k);
      cur.c = lerp3(cur.c, tgt.c, k);
      cur.d = lerp3(cur.d, tgt.d, k);
      cur.flow = lerp(cur.flow, wantFlow, k);
      cur.turb = lerp(cur.turb, wantTurb, k);
      cur.glow = lerp(cur.glow, wantGlow, k);
      cur.storm = lerp(cur.storm, wantStorm, k);

      // gentle autonomous drift so a still orb never looks frozen
      if (!dragging) {
        const t = (nowMs - startedAt) / 1000;
        target[0] = Math.sin(t * 0.11) * 0.5;
        target[1] = Math.sin(t * 0.07) * 0.18 - 0.05;
      }
      mouse[0] += (target[0] - mouse[0]) * 0.05;
      mouse[1] += (target[1] - mouse[1]) * 0.05;

      gl.useProgram(prog);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform1f(U.uTime, (nowMs - startedAt) / 1000);
      gl.uniform2f(U.uMouse, mouse[0], mouse[1]);
      gl.uniform1f(U.uFlow, cur.flow);
      gl.uniform1f(U.uTurb, cur.turb);
      gl.uniform1f(U.uGlow, cur.glow);
      gl.uniform1f(U.uStorm, cur.storm);
      gl.uniform1f(U.uMotion, motion);
      gl.uniform1f(U.uTransparent, transparentRef.current ? 1 : 0);
      gl.uniform3fv(U.uA, cur.a);
      gl.uniform3fv(U.uB, cur.b);
      gl.uniform3fv(U.uC, cur.c);
      gl.uniform3fv(U.uD, cur.d);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    raf = requestAnimationFrame(frame);

    const onLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(raf);
    };
    canvas.addEventListener('webglcontextlost', onLost);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener('webglcontextlost', onLost);
      if (interactive) {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
      }
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
      const ext = gl.getExtension('WEBGL_lose_context');
      ext?.loseContext();
    };
  }, [interactive]);

  return <canvas ref={canvasRef} className={className ? `orb ${className}` : 'orb'} aria-hidden="true" />;
}
