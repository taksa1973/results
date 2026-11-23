/* ════════════════════════════════════════════════════════════════════════
   3D-персонажи для звонков (three.js). Модели собираются кодом из простых
   форм — без файлов моделей и внешних сервисов, поэтому работают бесплатно
   и сразу. Губы двигаются по громкости голоса, персонаж моргает, дышит,
   жестикулирует, кивает, когда слушает, и «думает», пока ждёт ответ.

   createStage(host, {model, look}) — сцена во весь host;
   snapshot({model, look}, bgUrl) — портрет для карточек (dataURL).
   ════════════════════════════════════════════════════════════════════════ */
import * as THREE from './vendor/three.module.min.js';

export const VERSION = 3;
const Z = new THREE.Vector3(0, 0, 1);
const UNIT = new THREE.SphereGeometry(1, 40, 28);          // одна сфера на всех — меняется только масштаб
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const rnd = (a, b) => a + Math.random() * (b - a);

export function hasWebGL(){
  try{ const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); }catch(e){ return false; }
}

/* ── материалы и формы ── */
function M(color, o = {}){
  const p = { color: new THREE.Color(color), roughness: o.r ?? .62, metalness: 0 };
  if(o.side) p.side = THREE.DoubleSide;
  if(o.sheen) return new THREE.MeshPhysicalMaterial({ ...p, sheen: 1, sheenRoughness: .5, sheenColor: new THREE.Color(o.sheen) });
  if(o.gloss) return new THREE.MeshPhysicalMaterial({ ...p, roughness: .25, clearcoat: 1, clearcoatRoughness: .05 });
  if(o.basic) return new THREE.MeshBasicMaterial({ color: p.color });
  if(o.alpha) return new THREE.MeshStandardMaterial({ ...p, transparent: true, opacity: o.alpha, depthWrite: false });
  return new THREE.MeshStandardMaterial(p);
}
const HL = M('#ffffff', { basic: true });                    // блик в глазах
const shade = (hex, l, s = 0) => '#' + new THREE.Color(hex).offsetHSL(0, s, l).getHexString();
const mix = (a, b, k) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), k).getHexString();

function G(parent, pos = [0, 0, 0], rot){
  const g = new THREE.Group(); g.position.set(...pos); if(rot) g.rotation.set(...rot); parent.add(g); return g;
}
function S(parent, mat, pos, rad, rot){
  const m = new THREE.Mesh(UNIT, mat);
  m.position.set(...pos);
  if(typeof rad === 'number') m.scale.setScalar(rad); else m.scale.set(...rad);
  if(rot) m.rotation.set(...rot);
  parent.add(m); return m;
}
function Cap(parent, mat, r, len, pos = [0, 0, 0], rot){
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 8, 20), mat);
  m.position.set(...pos); if(rot) m.rotation.set(...rot); parent.add(m); return m;
}
function Cyl(parent, mat, r1, r2, len, pos, rot){
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 36, 1), mat);
  m.position.set(...pos); if(rot) m.rotation.set(...rot); parent.add(m); return m;
}
function Lathe(parent, mat, pts, pos = [0, 0, 0], scl = [1, 1, 1]){
  const m = new THREE.Mesh(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 56), mat);
  m.position.set(...pos); m.scale.set(...scl); parent.add(m); return m;
}
/* точка на поверхности эллипсоида (центр c, радиусы r) по углам: yaw — вправо-влево от «носа», pitch — вверх-вниз */
function surf(c, r, yaw, pitch, out = 0){
  const d = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  const t = 1 / Math.sqrt((d.x / r[0]) ** 2 + (d.y / r[1]) ** 2 + (d.z / r[2]) ** 2);
  const p = d.multiplyScalar(t);
  const n = new THREE.Vector3(p.x / r[0] ** 2, p.y / r[1] ** 2, p.z / r[2] ** 2).normalize();
  p.add(new THREE.Vector3(...c)).addScaledVector(n, out);
  return { p, n };
}
function place(parent, s, face = .5){
  const g = new THREE.Group(); g.position.copy(s.p);
  g.quaternion.setFromUnitVectors(Z, s.n.clone().lerp(Z, face).normalize());
  parent.add(g); return g;
}

/* ── глаз: белок, радужка, зрачок, блик; моргание — сжатие по вертикали ── */
function Eye(head, s, o){
  const g = place(head, s, o.face ?? .6);
  if(o.tilt) g.rotateZ(o.tilt);
  const lid = G(g);
  const sc = o.sc || [1, 1.08, .55], R = o.r;
  S(lid, o.white, [0, 0, 0], [R * sc[0], R * sc[1], R * sc[2]]);
  if(o.lidMat){                                   // верхнее веко: взгляд спокойнее, не «испуганный»
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI * (o.lidCover ?? .34)), o.lidMat);
    cap.scale.set(R * sc[0] * 1.08, R * sc[1] * 1.08, R * sc[2] * 1.25); cap.rotation.x = .18; lid.add(cap);
  }
  const look = G(lid, [0, 0, R * sc[2] * .86]);
  const ir = o.irisR || R * .55;
  if(o.style === 'full'){
    S(look, o.iris, [0, 0, 0], [ir, ir, ir * .3]);
    S(look, o.pupil, [0, 0, ir * .16], [ir * .5, ir * .5, ir * .2]);
  }else if(o.style === 'dot'){
    S(look, o.pupil, [0, 0, 0], [ir, ir * 1.1, ir * .35]);
  }
  S(look, HL, [ir * .38, ir * .42, ir * .42], ir * (o.style === 'black' ? .34 : .3));
  if(o.style === 'black') S(look, HL, [-ir * .3, -ir * .38, ir * .3], ir * .13);
  const line = Cap(g, o.line, R * .075, R * sc[0] * 1.5, [0, -R * .1, R * sc[2] * .92], [0, 0, Math.PI / 2]);
  line.visible = false;
  return { g, lid, look, line, range: R * (o.range ?? .3) };
}

/* ── рот: тёмная полость с языком растёт по громкости, закрытый — улыбка-дуга ── */
function Mouth(head, s, o){
  const g = place(head, s, o.face ?? .35);
  const cav = S(g, o.inner || M('#4a1420', { r: .8 }), [0, 0, 0], [o.w, o.h, o.d]);
  S(cav, o.tongue || M('#e46f7f', { r: .7 }), [0, -.5, .5], [.62, .42, .52]);
  if(o.teeth) S(cav, M('#fbfbf7', { r: .4 }), [0, .62, .48], [.7, .2, .5]);
  const arc = o.arc ?? 1.25, R = (o.w * (o.smileW ?? .95)) / Math.sin(arc / 2);
  const smile = new THREE.Mesh(new THREE.TorusGeometry(R, o.line ?? o.h * .16, 8, 36, arc), o.lip || M('#5a2028', { r: .7 }));
  smile.rotation.z = -Math.PI / 2 - arc / 2;
  smile.position.set(0, R - (o.h * .05), o.d * .35);
  g.add(smile);
  return {
    g, set(open, wide){
      const show = open > .08;
      cav.visible = show; smile.visible = !show;
      if(show) cav.scale.set(o.w * (.72 + .3 * wide + .15 * open), o.h * (.22 + .78 * open), o.d);
    },
  };
}

/* руки и ноги-«палочки» с суставами: плечо → локоть → кисть */
function Arm(parent, side, at, o){
  const sh = G(parent, at);
  Cap(sh, o.upper, o.r1, o.l1, [0, -o.l1 / 2, 0]);
  const el = G(sh, [0, -o.l1, 0]);
  Cap(el, o.lower || o.upper, o.r2, o.l2, [0, -o.l2 / 2, 0]);
  const hand = S(el, o.hand, [0, -o.l2 - o.r2 * .6, 0], o.handR || [o.r2 * 1.25, o.r2 * 1.45, o.r2 * .9]);
  return { s: side, sh, el, hand };
}

function base(hipY){
  const root = new THREE.Group();
  const hips = G(root, [0, hipY, 0]);
  const up = G(hips, [0, -hipY, 0]);
  return { root, hips, up, head: null, hc: [0, 0, 0], hr: [1, 1, 1], eyes: [], brows: [], mouth: null, arms: [],
           ears: [], tails: [], torso: null, yaw: 0, gest: 1, rest: null, nodK: 1 };
}

/* ════════════════ ЛЮДИ ════════════════ */
const HUMAN_DEFAULT = {
  gender: 'female', skin: '#e0ac86', eyes: '#4b3222', lips: '#b5615b',
  hair: { color: '#3b2619', style: 'long' }, beard: 'none', glasses: 'none',
  top: { color: '#5b8bd6', type: 'tshirt' }, bottom: { color: '#3c4a66', type: 'pants' }, shoes: '#f2f0ea', earrings: false,
};
function normLook(L){
  L = L && typeof L === 'object' ? L : {};
  const d = HUMAN_DEFAULT, hex = v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null;
  return {
    gender: L.gender === 'male' ? 'male' : 'female',
    skin: hex(L.skin) || d.skin, eyes: hex(L.eyes) || d.eyes, lips: hex(L.lips) || (L.gender === 'male' ? shade(hex(L.skin) || d.skin, -.18) : d.lips),
    hair: { color: hex(L.hair?.color) || d.hair.color, style: L.hair?.style || (L.gender === 'male' ? 'short' : 'long') },
    beard: L.beard || 'none', glasses: L.glasses || 'none',
    top: { color: hex(L.top?.color) || d.top.color, type: L.top?.type || 'tshirt' },
    bottom: { color: hex(L.bottom?.color) || d.bottom.color, type: L.bottom?.type || 'pants' },
    shoes: hex(L.shoes) || d.shoes, earrings: !!L.earrings,
  };
}

function human(lookIn){
  const L = normLook(lookIn);
  const fem = L.gender === 'female';
  const R = base(.47);
  const skin = M(L.skin, { r: .55 }), skinD = M(shade(L.skin, -.06), { r: .55 });
  const top = M(L.top.color, { r: .82 }), bot = M(L.bottom.color, { r: .85 });
  const shoe = M(L.shoes, { r: .5 }), hairM = M(L.hair.color, { r: .5, side: true });
  const dress = L.top.type === 'dress';
  const bareLegs = dress || ['skirt', 'shorts'].includes(L.bottom.type);

  // ноги и обувь — в корне (не качаются вместе с корпусом)
  for(const s of [-1, 1]){
    const x = s * .046;
    S(R.root, shoe, [x, .022, .016], [.034, .024, .062]);
    if(bareLegs){
      Cyl(R.root, skin, .033, .025, .42, [x, .25, 0]);
      if(L.bottom.type === 'shorts' && !dress) Cyl(R.root, bot, .05, .047, .15, [x, .395, 0]);
    }else{
      const wide = L.bottom.type === 'wide';
      Cyl(R.root, bot, .049, wide ? .062 : .037, .46, [x, .27, 0]);      // верх штанины уходит в таз — без «шва»
      S(R.root, bot, [x, .045, 0], [wide ? .062 : .037, .012, wide ? .062 : .037]);
    }
  }
  const up = R.up;
  // таз, юбка, корпус
  if(dress || L.bottom.type === 'skirt'){
    Lathe(up, dress ? top : bot, [[0, .5], [.088, .5], [.1, .44], [.125, .33], [.128, .31], [0, .31]], [0, 0, 0], [1, 1, .78]);
  }else Lathe(up, bot, [[0, .415], [.088, .415], [.091, .44], [.091, .47], [.089, .49], [.084, .51], [0, .51]], [0, 0, 0], [1, 1, .72]);
  const prof = fem
    ? [[0, .455], [.084, .47], [.079, .52], [.066, .6], [.074, .66], [.081, .7], [.079, .74], [.068, .768], [.036, .785], [0, .79]]
    : [[0, .455], [.086, .47], [.085, .53], [.083, .6], [.091, .67], [.1, .725], [.096, .762], [.06, .784], [0, .79]];
  R.torso = Lathe(up, top, prof, [0, 0, 0], [1, 1, .68]);
  if(L.top.type === 'tank' && fem) S(up, skin, [0, .772, .012], [.05, .022, .03]);   // открытые плечи и шея у майки
  Cyl(up, skin, .027, .03, .07, [0, .8, 0]);

  // руки
  const sleeveUp = ['tshirt', 'shirt', 'hoodie', 'dress'].includes(L.top.type);
  const sleeveLow = ['shirt', 'hoodie'].includes(L.top.type);
  for(const s of [-1, 1]){
    const sx = s * (fem ? .08 : .094);
    S(up, L.top.type === 'tank' ? skin : top, [sx * .96, .744, 0], [fem ? .028 : .032, fem ? .026 : .029, fem ? .028 : .031]);   // плечо
    R.arms.push(Arm(up, s, [sx, .742, 0], {
      upper: sleeveUp ? top : skin, lower: sleeveLow ? top : skin, hand: skin,
      r1: fem ? .024 : .028, l1: .115, r2: fem ? .02 : .023, l2: .105, handR: [fem ? .019 : .022, fem ? .026 : .029, fem ? .013 : .015] }));
  }
  R.rest = { sx: .04, sz: fem ? .17 : .2, ex: -.2, ez: 0 };

  // голова
  const head = R.head = G(up, [0, .815, 0]);
  head.scale.setScalar(1.2);                       // голова чуть крупнее «реальной» — мультяшные пропорции
  const hc = R.hc = [0, .088, .004], hr = R.hr = [.087, .103, .093];
  S(head, skin, hc, hr);
  for(const s of [-1, 1]) S(head, skin, [s * .086, hc[1] - .004, -.004], [.013, .023, .011]);
  // глаза, брови, нос, рот
  const white = M('#fbfbf8', { r: .3 }), iris = M(L.eyes, { r: .3 }), pupil = M('#120c0a', { r: .2 });
  const lineM = M(shade(L.skin, -.35), { r: .8 });
  const browM = M(shade(L.hair.color, -.03), { r: .7 });
  for(const s of [-1, 1]){
    R.eyes.push(Eye(head, surf(hc, hr, s * .38, .07, -.007), { r: .0225, irisR: .0135, style: 'full', white, iris, pupil, line: lineM, lidMat: skin }));
    const b = place(head, surf(hc, hr, s * .37, .265, .002), .5);
    Cap(b, browM, fem ? .0034 : .0045, .022, [0, 0, 0], [0, 0, Math.PI / 2 + s * .04]);
    R.brows.push(b);
  }
  S(head, skinD, surf(hc, hr, 0, -.1, -.002).p.toArray(), [.0105, .014, .014]);
  for(const s of [-1, 1]) S(head, M('#ff8f80', { alpha: .28 }), surf(hc, hr, s * .6, -.16, .001).p.toArray(), [.019, .012, .006]);
  const beard = L.beard !== 'none' && !fem ? L.beard : (L.beard === 'full' || L.beard === 'stubble' ? L.beard : 'none');
  R.mouth = Mouth(head, surf(hc, hr, 0, -.39, beard === 'full' ? .008 : .001), {
    w: .025, h: .016, d: .009, teeth: true, lip: M(fem ? L.lips : shade(L.skin, -.3), { r: .6 }), line: fem ? .0036 : .003, arc: 1.75, smileW: .9 });

  // волосы
  hairStyle(head, hc, hr, L.hair.style, hairM, fem);
  if(beard === 'stubble' || beard === 'full'){
    const bm = M(beard === 'full' ? L.hair.color : mix(L.skin, L.hair.color, .14), { r: .95, side: true });
    const g = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 18, 0, Math.PI, Math.PI * .56, Math.PI * .38), bm);
    g.position.set(...hc); g.scale.set(hr[0] * 1.03, hr[1] * 1.02, hr[2] * 1.04); head.add(g);
    if(beard === 'full') S(head, bm, [0, hc[1] - .09, .045], [.05, .03, .04]);
  }
  if(L.beard === 'mustache' && !fem){
    const m = place(head, surf(hc, hr, 0, -.28, .003), .4);
    Cap(m, M(L.hair.color, { r: .8 }), .0055, .026, [0, 0, 0], [0, 0, Math.PI / 2]);
  }
  if(L.glasses !== 'none'){
    const gm = M(L.glasses === 'gold' ? '#c9a24b' : '#1d1d22', { r: .35 });
    for(const s of [-1, 1]){
      const p = place(head, surf(hc, hr, s * .37, .07, .012), .85);
      p.add(new THREE.Mesh(new THREE.TorusGeometry(.024, .0026, 8, 36), gm));
    }
    Cyl(head, gm, .002, .002, .022, surf(hc, hr, 0, .08, .016).p.toArray(), [0, 0, Math.PI / 2]);
  }
  if(L.earrings) for(const s of [-1, 1]) S(head, M('#d9b15c', { r: .3 }), [s * .088, hc[1] - .03, .002], .006);
  R.gest = 1;
  return R;
}

/* причёски: «шапка» из части сферы + объёмы + кудри (много мелких шариков одним InstancedMesh) */
function hairStyle(head, hc, hr, style, mat, fem){
  const cap = (theta, tilt, k = 1.07, dy = .004) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, theta), mat);
    m.scale.set(hr[0] * k, hr[1] * k, hr[2] * k);
    m.position.set(hc[0], hc[1] + dy, hc[2] - .004);
    m.rotation.x = -tilt;
    head.add(m); m.updateMatrix(); return m;
  };
  const curls = (meshes, n, r0, r1, skipFace = true) => {
    const inst = new THREE.InstancedMesh(UNIT, mat, n);
    const v = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), m4 = new THREE.Matrix4();
    let k = 0, guard = 0;
    while(k < n && guard++ < n * 20){
      const src = meshes[Math.floor(Math.random() * meshes.length)];
      const th = src.userData.theta ?? Math.PI, ph = Math.random() * Math.PI * 2;
      const ct = 1 - Math.random() * (1 - Math.cos(th));
      const st = Math.sqrt(1 - ct * ct);
      v.set(st * Math.cos(ph), ct, st * Math.sin(ph)).applyMatrix4(src.matrix);
      const rel = v.clone().sub(new THREE.Vector3(...hc));
      if(skipFace && rel.z > .03 && Math.abs(rel.x) < .072 && rel.y < .055) continue;
      const r = rnd(r0, r1);
      m4.compose(v, q, sc.set(r, r, r)); inst.setMatrixAt(k++, m4);
    }
    inst.count = k; head.add(inst); return inst;
  };
  const vol = (pos, rad) => { const m = S(head, mat, [hc[0] + pos[0], hc[1] + pos[1], hc[2] + pos[2]], rad); m.updateMatrix(); return m; };
  const withTheta = (m, th) => { m.userData.theta = th; return m; };
  switch(style){
    case 'bald': break;
    case 'buzz': cap(Math.PI * .5, .5, 1.018); break;
    case 'short': {
      cap(Math.PI * .52, .62, 1.07);
      vol([0, .085, .004], [.078, .034, .074]);
      break;
    }
    case 'curly_short': {
      const c = withTheta(cap(Math.PI * .5, .6, 1.06), Math.PI * .44);
      vol([0, .08, -.004], [.08, .036, .078]);
      curls([c], 110, .013, .02);
      break;
    }
    case 'bun': {
      cap(Math.PI * .5, .42, 1.05);
      vol([0, .095, -.06], [.044, .042, .044]);
      break;
    }
    case 'ponytail': {
      cap(Math.PI * .5, .42, 1.05);
      const g = G(head, [hc[0], hc[1] + .045, hc[2] - .095], [.35, 0, 0]);
      S(g, mat, [0, 0, 0], .024);
      Cap(g, mat, .025, .11, [0, -.07, -.006]);
      break;
    }
    case 'bob': {
      cap(Math.PI * .52, .4, 1.07);
      vol([0, -.025, -.03], [.1, .09, .08]);
      for(const s of [-1, 1]) vol([s * .084, -.042, .006], [.03, .072, .062]);
      break;
    }
    case 'afro': {
      const c = withTheta(cap(Math.PI * .56, .28, 1.32, .02), Math.PI * .5);
      curls([c], 200, .02, .03, false);
      break;
    }
    case 'curly_long': {
      const c = withTheta(cap(Math.PI * .52, .4, 1.08), Math.PI * .45);
      const b = vol([0, -.055, -.058], [.122, .165, .075]);
      const sL = vol([-.094, -.05, -.012], [.042, .13, .062]), sR = vol([.094, -.05, -.012], [.042, .13, .062]);
      curls([c, b, sL, sR], 260, .016, .026);
      break;
    }
    case 'long':
    default: {
      cap(Math.PI * .52, .4, 1.07);
      vol([0, -.065, -.055], [.098, .155, .058]);
      for(const s of [-1, 1]) vol([s * .09, -.058, -.012], [.03, .125, .056]);
      if(fem) vol([.03, .086, .06], [.06, .028, .03]);          // чёлка набок
    }
  }
}

/* ════════════════ МУЛЬТЯШНЫЕ ════════════════ */
function peppa(){
  const R = base(.2);
  const pink = M('#f6a5b8', { r: .62 }), pinkD = M('#ec8ca4', { r: .6 }), red = M('#e8352d', { r: .78 });
  const black = M('#1d1b1f', { r: .45 });
  for(const s of [-1, 1]){
    Cyl(R.root, pink, .016, .016, .17, [s * .06, .11, 0]);
    S(R.root, black, [s * .062, .022, .02], [.045, .024, .062]);
  }
  R.torso = Lathe(R.up, red, [[0, .17], [.2, .17], [.212, .185], [.2, .205], [.16, .31], [.12, .42], [.098, .49], [.06, .515], [0, .52]], [0, 0, 0], [1, 1, .82]);
  for(const s of [-1, 1])
    R.arms.push(Arm(R.up, s, [s * .095, .47, 0], { upper: pink, hand: pink, r1: .016, l1: .1, r2: .016, l2: .09, handR: [.026, .026, .022] }));
  R.rest = { sx: .05, sz: .55, ex: -.25, ez: 0 };
  // голова в профиль, как в мультике: круглый затылок справа, пятачок-«фен» смотрит влево
  const head = R.head = G(R.up, [0, .5, 0]);
  const hc = R.hc = [.05, .17, 0], hr = R.hr = [.15, .14, .135];
  S(head, pink, hc, hr);
  Cyl(head, pink, .074, .098, .21, [-.1, .195, 0], [0, 0, Math.PI / 2 - .16]);
  const tip = G(head, [-.205, .212, 0], [0, 0, -.16]);
  S(tip, pinkD, [0, 0, 0], [.02, .078, .078]);
  for(const s of [-1, 1]) S(tip, M('#a84d68', { r: .7 }), [-.014, 0, s * .03], [.008, .018, .013]);
  const white = M('#ffffff', { r: .35 }), dot = M('#151515', { r: .3 });
  const eyeAt = (x, y, z) => ({ p: new THREE.Vector3(x, y, z), n: new THREE.Vector3(-.15, .35, 1).normalize() });
  R.eyes.push(Eye(head, eyeAt(-.12, .268, .05), { r: .03, sc: [1, 1.05, .55], style: 'dot', irisR: .011, white, pupil: dot, line: black, face: .2, range: .3 }));
  R.eyes.push(Eye(head, eyeAt(-.045, .282, .066), { r: .03, sc: [1, 1.05, .55], style: 'dot', irisR: .011, white, pupil: dot, line: black, face: .2, range: .3 }));
  for(const [x, rz] of [[.02, .12], [.11, -.25]]){
    const e = G(head, [x, .295, -.01], [0, 0, rz]);
    const c = new THREE.Mesh(new THREE.ConeGeometry(.034, .075, 24), pink); c.position.y = .03; e.add(c);
    R.ears.push({ g: e, base: [0, 0, rz], amp: .07 });
  }
  S(head, M('#f0789a', { r: .7 }), surf(hc, hr, .55, -.2, -.004).p.toArray(), [.042, .042, .012]);
  R.mouth = Mouth(head, surf(hc, hr, -.5, -.6, .002), { w: .05, h: .028, d: .014, lip: M('#7d2a3f', { r: .7 }), line: .0055, arc: 1.5 });
  // хвостик-завиток
  const tail = new THREE.Mesh(new THREE.TorusGeometry(.022, .006, 8, 24, Math.PI * 1.6), pink);
  tail.position.set(0, .25, -.15); tail.rotation.y = Math.PI / 2; R.up.add(tail);
  R.tails.push({ g: tail, base: [0, Math.PI / 2, 0], amp: .4 });
  R.yaw = .32; R.gest = .9;
  return R;
}

function stitch(){
  const R = base(.15);
  const blue = M('#4b72c1', { r: .7, sheen: '#9fbcf2' }), blueD = M('#34539a', { r: .7 }), light = M('#a9c3ea', { r: .75, sheen: '#e2ecff' });
  const pinkIn = M('#d79bc3', { r: .7 }), navy = M('#1f2747', { r: .35 }), black = M('#0c0c12', { gloss: true });
  for(const s of [-1, 1]){
    Cap(R.root, blue, .045, .06, [s * .07, .11, 0]);
    S(R.root, blueD, [s * .072, .035, .022], [.062, .034, .082]);
  }
  R.torso = S(R.up, blue, [0, .27, 0], [.13, .165, .11]);
  S(R.up, light, [0, .255, .068], [.088, .125, .06]);
  for(const s of [-1, 1])
    R.arms.push(Arm(R.up, s, [s * .108, .36, 0], { upper: blue, hand: blueD, r1: .031, l1: .07, r2: .028, l2: .07, handR: [.036, .04, .03] }));
  R.rest = { sx: .1, sz: .38, ex: -.35, ez: 0 };
  const head = R.head = G(R.up, [0, .4, 0]);
  const hc = R.hc = [0, .14, .01], hr = R.hr = [.195, .15, .155];
  S(head, blue, hc, hr);
  S(head, light, [0, .09, .085], [.13, .07, .08]);                         // светлая мордочка
  S(head, navy, surf(hc, hr, 0, -.08, .02).p.toArray(), [.052, .036, .036]);  // нос
  const white = black, line = navy;
  for(const s of [-1, 1]){
    R.eyes.push(Eye(head, surf(hc, hr, s * .42, .16, -.008), { r: .046, sc: [1, 1.16, .55], style: 'black', irisR: .03, white, line, face: .45, range: .12, tilt: -s * .12 }));
    const b = place(head, surf(hc, hr, s * .42, .42, -.004), .4);
    S(b, blueD, [0, 0, 0], [.05, .018, .02], [0, 0, -s * .12]);
    R.brows.push(b);
  }
  for(const s of [-1, 1]){
    const e = G(head, [s * .15, .22, -.01], [0, 0, -s * .62]);
    S(e, blue, [0, .14, 0], [.07, .16, .022]);
    S(e, pinkIn, [0, .13, .014], [.05, .12, .012]);
    R.ears.push({ g: e, base: [0, 0, -s * .62], amp: .12 });
  }
  for(let i = -1; i <= 1; i++){
    const c = new THREE.Mesh(new THREE.ConeGeometry(.012, .05, 12), blueD);
    c.position.set(i * .018, hc[1] + hr[1] + .012, .01); c.rotation.z = -i * .4; head.add(c);
  }
  R.mouth = Mouth(head, surf(hc, hr, 0, -.42, .012), { w: .075, h: .04, d: .018, lip: navy, line: .0055, arc: 1.4, teeth: true });
  R.gest = 1.1;
  return R;
}

function luntik(){
  const R = base(.16);
  const fur = M('#9b70db', { r: .85, sheen: '#d9c2ff' }), furL = M('#b896ea', { r: .85, sheen: '#efe4ff' });
  const pinkIn = M('#e4a6e0', { r: .8 }), cheek = M('#f39bd0', { r: .8 }), spot = M('#d7c0fa', { r: .8 });
  for(const s of [-1, 1]){
    Cap(R.root, fur, .055, .06, [s * .075, .11, 0]);
    S(R.root, fur, [s * .078, .04, .024], [.07, .04, .09]);
  }
  R.torso = S(R.up, fur, [0, .3, 0], [.155, .19, .14]);
  S(R.up, furL, [0, .28, .085], [.1, .13, .06]);
  for(const s of [-1, 1])
    R.arms.push(Arm(R.up, s, [s * .135, .4, 0], { upper: fur, hand: fur, r1: .042, l1: .06, r2: .038, l2: .06, handR: [.048, .05, .042] }));
  R.rest = { sx: .1, sz: .35, ex: -.3, ez: 0 };
  const head = R.head = G(R.up, [0, .45, 0]);
  const hc = R.hc = [0, .17, .01], hr = R.hr = [.2, .185, .175];
  S(head, fur, hc, hr);
  const white = M('#fdfcff', { r: .25 }), iris = M('#5b3a99', { r: .3 }), pupil = M('#1b0f2e', { r: .2 });
  for(const s of [-1, 1])
    R.eyes.push(Eye(head, surf(hc, hr, s * .33, .02, -.012), { r: .05, sc: [1, 1.12, .5], style: 'full', irisR: .034, white, iris, pupil, line: M('#3a2266'), range: .26 }));
  for(const [x, y, r] of [[-.035, .31, .011], [.02, .325, .013], [.06, .3, .009], [-.07, .29, .008]])
    S(head, spot, surf(hc, hr, Math.atan2(x, .17), Math.asin((y - hc[1]) / hr[1]), -.003).p.toArray(), [r, r, r * .5]);
  for(const s of [-1, 1]) S(head, cheek, surf(hc, hr, s * .62, -.22, -.004).p.toArray(), [.03, .02, .012]);
  S(head, M('#7d52bf'), surf(hc, hr, 0, -.2, 0).p.toArray(), [.012, .009, .01]);
  R.mouth = Mouth(head, surf(hc, hr, 0, -.36, .002), { w: .036, h: .024, d: .012, lip: M('#4a2a7a'), line: .0045, arc: 1.4 });
  // длинные уши: от макушки в стороны и вниз, второй сегмент свисает
  for(const s of [-1, 1]){
    const e = G(head, [s * .12, .315, -.01], [0, 0, -s * .75]);
    S(e, fur, [0, .07, 0], [.058, .095, .032]);
    S(e, pinkIn, [0, .07, .02], [.04, .068, .016]);
    const e2 = G(e, [0, .14, 0], [0, 0, -s * 2.05]);
    S(e2, fur, [0, .1, 0], [.066, .13, .03]);
    S(e2, pinkIn, [0, .095, .018], [.046, .1, .014]);
    R.ears.push({ g: e, base: [0, 0, -s * .75], amp: .06 }, { g: e2, base: [0, 0, -s * 2.05], amp: .1, lag: 1 });
  }
  R.gest = 1;
  return R;
}

function pikachu(){
  const R = base(.12);
  const yel = M('#f7cf35', { r: .6, sheen: '#fff2b0' }), brown = M('#9a6130', { r: .7 }), black = M('#141414', { gloss: true });
  const red = M('#e8452f', { r: .6 });
  for(const s of [-1, 1]) S(R.root, yel, [s * .07, .03, .03], [.06, .03, .085]);
  R.torso = S(R.up, yel, [0, .22, 0], [.145, .18, .13]);
  for(const s of [-1, 1]) S(R.up, brown, [0, .27 - (s + 1) * .035, -.118], [.1, .018, .02]);
  for(const s of [-1, 1])
    R.arms.push(Arm(R.up, s, [s * .1, .31, .03], { upper: yel, hand: yel, r1: .028, l1: .05, r2: .026, l2: .05, handR: [.032, .034, .03] }));
  R.rest = { sx: -.5, sz: .3, ex: -.8, ez: 0 };
  const head = R.head = G(R.up, [0, .36, 0]);
  const hc = R.hc = [0, .14, .01], hr = R.hr = [.17, .14, .145];
  S(head, yel, hc, hr);
  for(const s of [-1, 1]){
    R.eyes.push(Eye(head, surf(hc, hr, s * .4, .1, -.008), { r: .032, sc: [1, 1.1, .55], style: 'black', irisR: .022, white: black, line: black, range: .12 }));
    S(head, red, surf(hc, hr, s * .75, -.22, -.006).p.toArray(), [.034, .034, .014]);
  }
  S(head, black, surf(hc, hr, 0, -.08, 0).p.toArray(), [.009, .006, .006]);
  R.mouth = Mouth(head, surf(hc, hr, 0, -.3, .002), { w: .032, h: .026, d: .012, lip: M('#5a2a1a'), line: .004, arc: 1.6 });
  for(const s of [-1, 1]){
    const e = G(head, [s * .095, .24, -.01], [0, 0, -s * .42]);
    S(e, yel, [0, .14, 0], [.042, .15, .03]);
    S(e, M('#141414', { r: .5 }), [0, .255, 0], [.034, .05, .026]);
    R.ears.push({ g: e, base: [0, 0, -s * .42], amp: .14 });
  }
  // хвост-молния
  const sh = new THREE.Shape();
  [[0, 0], [.05, .02], [.03, .09], [.11, .1], [.08, .2], [.2, .24], [.17, .32], [.04, .26], [.07, .17], [-.01, .16], [.015, .08], [-.03, .06]]
    .forEach(([x, y], i) => i ? sh.lineTo(x, y) : sh.moveTo(x, y));
  const tg = new THREE.ExtrudeGeometry(sh, { depth: .025, bevelEnabled: true, bevelThickness: .008, bevelSize: .008, bevelSegments: 2 });
  const tail = new THREE.Mesh(tg, yel); tail.position.set(.07, .1, -.15); tail.rotation.set(0, -.25, -.1);
  R.up.add(tail);
  S(R.up, brown, [.075, .11, -.14], [.035, .03, .022]);
  R.tails.push({ g: tail, base: [0, -.25, -.1], amp: .25 });
  R.gest = .9;
  return R;
}

export const MODELS = { human, peppa, stitch, luntik, pikachu };

/* ── сборка: модель → рост 1, ступни на нуле ── */
function build(spec){
  const make = MODELS[spec?.model] || human;
  const R = make(spec?.look);
  R.root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(R.root);
  const k = 1 / (box.max.y - Math.min(0, box.min.y));
  R.root.scale.setScalar(k);
  R.width = (box.max.x - box.min.x) * k;
  R.depth = (box.max.z - box.min.z) * k;
  R.root.rotation.y = R.yaw;
  R.root.updateMatrixWorld(true);
  return R;
}
function lights(scene){
  scene.add(new THREE.HemisphereLight('#ffffff', '#c9b8a6', 1.45));
  const key = new THREE.DirectionalLight('#fff4e6', 2.3); key.position.set(-1.3, 2.4, 2.6); scene.add(key);
  const fill = new THREE.DirectionalLight('#dfe9ff', .7); fill.position.set(1.6, .9, 2); scene.add(fill);
  const rim = new THREE.DirectionalLight('#ffffff', 1.5); rim.position.set(.8, 1.8, -2.4); scene.add(rim);
}
function blobShadow(w){
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,.42)'); gr.addColorStop(.55, 'rgba(0,0,0,.2)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = .002; m.scale.set(Math.max(.42, w * 1.05), Math.max(.22, w * .45), 1);
  return m;
}
function disposeTree(o){
  o.traverse(n => {
    if(n.geometry && n.geometry !== UNIT) n.geometry.dispose();
    if(n.material){ (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => { if(m !== HL){ m.map?.dispose(); m.dispose(); } }); }
  });
}

/* ════════════════ АНИМАЦИЯ ════════════════ */
const GESTURES = [
  { sx: -.55, sz: .22, ex: -1.2, ez: 0 },
  { sx: -.32, sz: .55, ex: -.8, ez: .25 },
  { sx: -.22, sz: .28, ex: -.7, ez: 0 },
  { sx: -.8, sz: .12, ex: -.55, ez: 0 },
  { sx: -.45, sz: .4, ex: -1.0, ez: .1 },
];
function animator(R, reduced){
  const rest = R.rest || { sx: .04, sz: .16, ex: -.14, ez: 0 };
  const st = { t: 0, mode: 'idle', env: 0, open: 0, wide: 0, blinkAt: rnd(1, 3), blink: -1, look: [0, 0], lookT: [0, 0], lookAt: 0,
               gestAt: 0, wave: -1, cheer: -1, nod: -1, micHi: 0, lastNod: 0, quiet: 0, hx: 0, hy: 0, hz: 0, by: 0 };
  const ph = Array.from({ length: 12 }, () => Math.random() * 6.283);
  const arms = R.arms.map(a => ({ a, cur: { ...rest }, tgt: { ...rest } }));
  const k = reduced ? .4 : 1;

  function poseArms(dt){
    if(st.env > .45 && st.t > st.gestAt && R.gest > 0){
      st.gestAt = st.t + rnd(.8, 1.9);
      const which = Math.random();
      arms.forEach((x, i) => {
        const use = which < .4 ? i === 0 : which < .8 ? i === 1 : true;
        const g = GESTURES[Math.floor(Math.random() * GESTURES.length)];
        x.tgt = use ? { sx: rest.sx + (g.sx - rest.sx) * R.gest * k, sz: rest.sz + (g.sz - rest.sz) * R.gest * k,
                        ex: rest.ex + (g.ex - rest.ex) * R.gest * k, ez: g.ez * R.gest * k } : { ...rest };
      });
    }
    if(st.env < .15) arms.forEach(x => { x.tgt = { ...rest }; });
    arms.forEach((x, i) => {
      let t = x.tgt;
      if(st.wave >= 0 && i === 0){
        const w = Math.min(1, st.wave / .3, (2.2 - st.wave) / .4);
        t = { sx: -.15, sz: 1.35, ex: -.1, ez: 1.25 + .38 * Math.sin(st.wave * 11) };
        t = lerpPose(x.tgt, t, clamp(w, 0, 1));
      }
      if(st.cheer >= 0){
        const w = Math.min(1, st.cheer / .15, (1 - st.cheer) / .3);
        t = lerpPose(t, { sx: -.2, sz: 2.55, ex: -.25, ez: .25 }, clamp(w, 0, 1));
      }
      const sp = st.wave >= 0 || st.cheer >= 0 ? 14 : 5.5;
      for(const key of ['sx', 'sz', 'ex', 'ez']) x.cur[key] = damp(x.cur[key], t[key], sp, dt);
      const breath = .02 * Math.sin(st.t * 2.1 + i) * k;
      x.a.sh.rotation.set(x.cur.sx, 0, x.a.s * (x.cur.sz + breath));
      x.a.el.rotation.set(x.cur.ex, 0, x.a.s * x.cur.ez);
    });
  }
  const lerpPose = (a, b, w) => ({ sx: a.sx + (b.sx - a.sx) * w, sz: a.sz + (b.sz - a.sz) * w, ex: a.ex + (b.ex - a.ex) * w, ez: a.ez + (b.ez - a.ez) * w });

  function update(dt, voice, mic){
    dt = Math.min(dt, .05);
    const t = st.t += dt;
    // голос → рот (быстро открывается, чуть медленнее закрывается)
    const target = st.mode === 'ai' ? clamp((voice - .018) * 7, 0, 1) : 0;
    st.open = damp(st.open, target, target > st.open ? 32 : 16, dt);
    st.wide = damp(st.wide, .5 + .5 * Math.sin(t * 7.3 + ph[0]) * Math.sin(t * 3.1), 10, dt);
    st.env = damp(st.env, st.mode === 'ai' && voice > .025 ? 1 : 0, st.mode === 'ai' ? 3 : 2, dt);
    let open = st.open, wide = st.wide;
    if(st.cheer >= 0){ open = Math.max(open, .55 * Math.sin(Math.PI * clamp(st.cheer, 0, 1))); wide = 1; }
    R.mouth?.set(open, wide);

    // голова
    let hx = .025 * Math.sin(t * .9 + ph[1]) + .015 * Math.sin(t * 2.3 + ph[2]);
    let hy = .07 * Math.sin(t * .45 + ph[3]) + .03 * Math.sin(t * 1.3 + ph[4]);
    let hz = .03 * Math.sin(t * .7 + ph[5]);
    let lookT = st.lookT, brow = 0;
    if(st.mode === 'ai'){
      hx += -.05 * st.env * Math.sin(t * 4.2 + ph[6]) - .08 * st.open * R.nodK;
      hy += .05 * st.env * Math.sin(t * 1.7 + ph[7]);
      brow = .5 * Math.max(0, st.open - .45);
    }else if(st.mode === 'rec'){
      hz += .11; hx += .04;
      if(mic > .06 && st.micHi < .06 && t - st.lastNod > 1.3){ st.nod = 0; st.lastNod = t; }
      st.micHi = mic;
    }else if(st.mode === 'busy'){
      hx += -.13; hy += .22; hz += .05; lookT = [.75, .8]; brow = .8;
    }
    if(st.nod >= 0){ st.nod += dt; hx += .14 * Math.sin(Math.min(1, st.nod / .55) * Math.PI * 2) * (st.nod < .55 ? 1 : 0); if(st.nod > .6) st.nod = -1; }
    if(st.cheer >= 0){ hx += -.12 * Math.sin(Math.PI * clamp(st.cheer, 0, 1)); }
    st.hx = damp(st.hx, hx * k, 7, dt); st.hy = damp(st.hy, hy * k, 5, dt); st.hz = damp(st.hz, hz * k, 5, dt);
    R.head.rotation.set(st.hx, st.hy, st.hz);

    // взгляд: короткие «саккады» около камеры
    if(st.mode !== 'busy' && t > st.lookAt){ st.lookAt = t + rnd(.6, 2.6); st.lookT = Math.random() < .7 ? [rnd(-.25, .25), rnd(-.15, .2)] : [0, 0]; }
    st.look[0] = damp(st.look[0], lookT[0], 18, dt); st.look[1] = damp(st.look[1], lookT[1], 18, dt);
    // моргание
    if(t > st.blinkAt){ st.blink = 0; st.blinkAt = t + (Math.random() < .15 ? .25 : rnd(2.2, 5.2)); }
    let lid = 1;
    if(st.blink >= 0){ st.blink += dt; lid = 1 - .95 * Math.sin(Math.PI * Math.min(1, st.blink / .16)); if(st.blink > .16) st.blink = -1; }
    if(st.cheer >= 0) lid = Math.min(lid, 1 - .5 * Math.sin(Math.PI * clamp(st.cheer, 0, 1)));
    for(const e of R.eyes){
      e.lid.scale.y = Math.max(.06, lid);
      e.line.visible = lid < .25;
      e.look.position.x = st.look[0] * e.range; e.look.position.y = st.look[1] * e.range;
    }
    R.brows.forEach((b, i) => { b.userData.y0 ??= b.position.y; b.position.y = b.userData.y0 + .006 * brow * (i ? 1 : .7); });

    // корпус: дыхание, покачивание, прыжок от радости
    const breathe = Math.sin(t * 2.1);
    if(R.torso){ R.torso.userData.s0 ??= R.torso.scale.clone(); const s0 = R.torso.userData.s0;
      R.torso.scale.set(s0.x * (1 + .012 * breathe * k), s0.y, s0.z * (1 + .016 * breathe * k)); }
    R.up.position.y = -R.hips.position.y + .003 * breathe * k + .004 * st.open * k;
    R.hips.rotation.z = (.018 * Math.sin(t * .7 + ph[8]) + .02 * st.env * Math.sin(t * 2.4)) * k;
    R.hips.rotation.y = .04 * Math.sin(t * .33 + ph[9]) * k;
    let jump = 0;
    if(st.cheer >= 0){ st.cheer += dt / .9; jump = Math.max(0, Math.sin(Math.PI * Math.min(1, st.cheer * 1.4))) * .05; if(st.cheer > 1) st.cheer = -1; }
    R.root.position.y = jump * k;
    if(st.wave >= 0){ st.wave += dt; if(st.wave > 2.2) st.wave = -1; }

    // уши и хвосты
    for(const e of R.ears){
      const w = Math.sin(t * (e.lag ? 2.2 : 1.6) + ph[10] + (e.lag ? 1 : 0)) * e.amp * .3 + e.amp * st.open * .6 * Math.sin(t * 9 + ph[11]);
      e.g.rotation.set(e.base[0] + w * .3 * k, e.base[1], e.base[2] + w * k);
    }
    for(const tl of R.tails) tl.g.rotation.set(tl.base[0], tl.base[1] + Math.sin(t * 3) * tl.amp * .5 * k, tl.base[2] + Math.sin(t * 2.2) * tl.amp * .3 * k);
    poseArms(dt);
  }
  return {
    update,
    setMode(m){ st.mode = m; if(m !== 'busy') st.lookT = [0, 0]; },
    wave(){ st.wave = 0; },
    cheer(){ st.cheer = 0; },
  };
}

/* ════════════════ СЦЕНА ════════════════ */
export function createStage(host, spec, opt = {}){
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.02;
  const cv = renderer.domElement;
  cv.className = 'pt-3d-cv'; cv.setAttribute('aria-hidden', 'true');
  host.appendChild(cv);
  const scene = new THREE.Scene();
  lights(scene);
  const R = build(spec);
  scene.add(R.root);
  scene.add(blobShadow(R.width));
  const cam = new THREE.PerspectiveCamera(26, 1, .05, 30);
  const A = animator(R, reduced);
  const top = opt.top ?? .24, tall = opt.tall ?? .66;   // макушка на 24 % высоты экрана, рост — 66 %

  function resize(){
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    let visH = 1 / tall;
    if(R.width > visH * cam.aspect * .9) visH = R.width / (cam.aspect * .9);
    const cy = 1 - (.5 - top) * visH;
    const dist = (visH / 2) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    cam.position.set(0, cy, dist);
    cam.lookAt(0, cy, 0);
    cam.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize); ro.observe(host); resize();
  const clock = new THREE.Clock();
  const api = {
    voice: () => 0, mic: () => 0,
    setMode: m => A.setMode(m), wave: () => A.wave(), cheer: () => A.cheer(),
    dispose(){ renderer.setAnimationLoop(null); ro.disconnect(); disposeTree(scene); renderer.dispose(); renderer.forceContextLoss?.(); cv.remove(); },
  };
  renderer.setAnimationLoop(() => {
    const dt = clock.getDelta();
    let v = 0, m = 0;
    try{ v = api.voice() || 0; m = api.mic() || 0; }catch(e){}
    A.update(dt, v, m);
    renderer.render(scene, cam);
  });
  return api;
}

/* ════════════════ ПОРТРЕТ ДЛЯ КАРТОЧЕК ════════════════ */
let snapR = null;
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
export async function snapshot(spec, bgUrl, w = 360, h = 480){
  if(!snapR){
    snapR = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    snapR.setClearColor(0x000000, 0);
    snapR.toneMapping = THREE.NeutralToneMapping; snapR.toneMappingExposure = 1.02;
  }
  snapR.setPixelRatio(1);
  snapR.setSize(w, h, false);
  const scene = new THREE.Scene(); lights(scene);
  const R = build(spec); scene.add(R.root);
  R.mouth?.set(0, .5);
  const c = new THREE.Vector3(...R.hc); R.head.localToWorld(c);
  const hr = R.hr[1] * R.root.scale.y * R.head.scale.y;
  const cam = new THREE.PerspectiveCamera(24, w / h, .05, 30);
  const visH = Math.max(hr * 4.6, .42), cy = c.y - hr * .55;
  const dist = (visH / 2) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
  cam.position.set(0, cy, c.z + dist); cam.lookAt(0, cy, c.z); cam.updateProjectionMatrix();
  snapR.render(scene, cam);
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const g = out.getContext('2d');
  if(bgUrl){
    try{
      const im = await loadImg(bgUrl);
      const sw = im.width * .62, sh = sw * h / w;
      g.drawImage(im, (im.width - sw) / 2, im.height * .16, sw, sh, 0, 0, w, h);
    }catch(e){ g.fillStyle = '#cfe3f5'; g.fillRect(0, 0, w, h); }
  }
  g.drawImage(snapR.domElement, 0, 0, w, h);
  disposeTree(scene);
  return out.toDataURL('image/jpeg', .88);
}
