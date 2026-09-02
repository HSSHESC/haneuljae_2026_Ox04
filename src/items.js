// src/items.js — 아이템 박스, 픽업/지급, 아이템 효과 (mushroom/shell/banana/star)
import * as THREE from 'three';

const BOX_RESPAWN = 3;      // 초
const PICKUP_RADIUS = 1.6;  // m
const SHELL_SPEED = 25;     // m/s (+ 사용자 속도)
const SHELL_RADIUS = 0.45;
const SHELL_HIT_RADIUS = 1.2;
const SHELL_LIFETIME = 6;   // 초 (안전장치)
const SHELL_HEIGHT = 0.4;  // 노면 위 셸 중심 높이 (경사에서도 매 프레임 이 높이로 밀착)
const BANANA_HIT_RADIUS = 1.1;
const BALLOON_SPEED = 18;    // m/s 수평 초속(+ 사용자 속도의 50%)
const BALLOON_UP = 9.0;      // m/s 초기 상승
const BALLOON_G = 22;        // m/s² 중력
const BALLOON_LIFE = 3.0;    // s 안전장치
const BALLOON_HIT_R = 1.4;   // 직격 판정 반경
const PUDDLE_R = 4.0;        // 웅덩이 반경(m)
const PUDDLE_LIFE = 8.0;     // s
const PUDDLE_TRIG_R = 4.6;   // PUDDLE_R + 0.6
const PUDDLE_LEVEL_DY = 5.0; // 웅덩이 판정의 레벨 분리 높이차(2층 맵에서 위/아래층 오판 방지)
const SLIP_DUR = 1.6;        // kart.applySlip 지속(초)
const ITEM_TYPES = ['mushroom', 'shell', 'banana', 'star', 'balloon'];

export class ItemSystem {
  constructor(scene, track) {
    this.scene = scene;
    this.track = track;

    // 공유 지오메트리/머티리얼
    this._boxGeo = new THREE.BoxGeometry(1.1, 1.1, 1.1);
    this._boxMat = new THREE.MeshStandardMaterial({
      color: 0x66ccff,
      transparent: true,
      opacity: 0.55,
      emissive: 0x2288cc,
      emissiveIntensity: 0.6,
      roughness: 0.2,
      metalness: 0.1,
    });
    this._shellGeo = new THREE.SphereGeometry(SHELL_RADIUS, 12, 8);
    this._shellMat = new THREE.MeshStandardMaterial({ color: 0x22aa33, roughness: 0.4 });
    this._bananaGeo = new THREE.ConeGeometry(0.35, 0.5, 8);
    this._bananaMat = new THREE.MeshStandardMaterial({ color: 0xffdd33, roughness: 0.6 });
    this._balloonGeo = new THREE.SphereGeometry(0.35, 10, 8);
    this._balloonMat = new THREE.MeshStandardMaterial({ color: 0x3fb6e8, roughness: 0.3, metalness: 0.05 });

    // 아이템전/스피드전 모드 스위치. false면 박스가 숨고 픽업/사용/발사체 갱신이 멈춘다.
    this.enabled = true;

    // 아이템 박스 생성
    this.boxes = [];
    const positions = (track && track.itemBoxPositions) || [];
    for (const p of positions) {
      const mesh = new THREE.Mesh(this._boxGeo, this._boxMat);
      mesh.position.copy(p); // track.itemBoxPositions가 이미 노면 높이(경사 포함) + 1.0으로 띄워서 준다
      scene.add(mesh);
      this.boxes.push({
        mesh,
        basePos: mesh.position.clone(),
        active: true,
        respawnTimer: 0,
        spinPhase: Math.random() * Math.PI * 2,
      });
    }

    this.shells = [];   // { mesh, velocity:Vector3, owner, life }
    this.bananas = [];  // { mesh, owner, armTimer }
    this.balloons = []; // { mesh, vel:Vector3, owner, life, _sampleHint }
    this.puddles = [];  // { mesh, life, age, owner, ownerGrace } — 지오메트리/머티리얼이 위치별로 달라 인스턴스마다 새로 만든다
  }

  // 맵 전환 시 main이 호출: 씬에 add한 것 전부 제거 + 자체 생성 GPU 리소스 해제.
  // (지오메트리/머티리얼은 전부 이 클래스가 만든 것이라 dispose 대상이다)
  dispose() {
    for (const box of this.boxes) this.scene.remove(box.mesh);
    this._clearProjectiles();
    this.boxes.length = 0;

    this._boxGeo.dispose();
    this._boxMat.dispose();
    this._shellGeo.dispose();
    this._shellMat.dispose();
    this._bananaGeo.dispose();
    this._bananaMat.dispose();
    this._balloonGeo.dispose();
    this._balloonMat.dispose();
  }

  // 아이템전 ⇄ 스피드전 전환. 비활성화 시 박스를 숨기고 픽업/사용을 막으며 날아다니는
  // 발사체와 설치물(웅덩이 포함)을 전부 정리한다. 재활성화 시 박스는 각자의 active 상태로 복귀한다.
  setEnabled(enabled) {
    this.enabled = !!enabled;
    for (const b of this.boxes) b.mesh.visible = this.enabled && b.active;
    if (!this.enabled) this._clearProjectiles();
  }

  // 씬에서 발사체/설치물을 전부 제거(공유 박스/셸/바나나/물풍선 지오메트리·머티리얼은 유지 —
  // setEnabled(true)로 복귀 후에도 그대로 재사용한다). 웅덩이는 인스턴스별 자원이라 여기서 dispose한다.
  _clearProjectiles() {
    for (const s of this.shells) this.scene.remove(s.mesh);
    for (const b of this.bananas) this.scene.remove(b.mesh);
    for (const bl of this.balloons) this.scene.remove(bl.mesh);
    for (const p of this.puddles) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
    }
    this.shells.length = 0;
    this.bananas.length = 0;
    this.balloons.length = 0;
    this.puddles.length = 0;
  }

  update(dt, karts) {
    if (!this.enabled) return; // 스피드전: 박스는 setEnabled에서 이미 숨겼고 여기서 픽업/발사체 갱신을 멈춘다

    // 박스 회전/부유 + 리스폰
    for (const box of this.boxes) {
      box.spinPhase += dt;
      if (box.active) {
        box.mesh.rotation.y += dt * 2.0;
        box.mesh.rotation.x += dt * 1.1;
        box.mesh.position.y = box.basePos.y + Math.sin(box.spinPhase * 2) * 0.12;
      } else {
        box.respawnTimer -= dt;
        if (box.respawnTimer <= 0) {
          box.active = true;
          box.mesh.visible = true;
          box.mesh.scale.setScalar(1);
        }
      }
    }

    // 픽업 판정
    for (const kart of karts) {
      if (kart.item === undefined) kart.item = null; // 초기화 (동적 필드)
      if (kart.item !== null) continue;
      for (const box of this.boxes) {
        if (!box.active) continue;
        // 박스는 노면 위 1m에 떠 있고, 픽업은 항상 수평(XZ) 거리로 판정한다 — 경사에서도 무관.
        const dx = kart.position.x - box.mesh.position.x;
        const dz = kart.position.z - box.mesh.position.z;
        if (dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS) {
          box.active = false;
          box.mesh.visible = false;
          box.respawnTimer = BOX_RESPAWN;
          kart.item = this._rollItem(kart, karts);
          break;
        }
      }
    }

    this._updateShells(dt, karts);
    this._updateBananas(dt, karts);
    this._updateBalloons(dt, karts);
    this._updatePuddles(dt, karts);
  }

  use(kart, allKarts) {
    if (!this.enabled) { kart.item = null; return; } // 스피드전: 아이템 자체가 없다
    const item = kart.item;
    if (!item) return;
    kart.item = null;
    switch (item) {
      case 'mushroom':
        kart.applyBoost(1, 1.2);
        break;
      case 'star':
        kart.setStar(5);
        break;
      case 'shell':
        this._spawnShell(kart);
        break;
      case 'banana':
        this._spawnBanana(kart);
        break;
      case 'balloon':
        this._spawnBalloon(kart);
        break;
    }
  }

  // ---- 내부 구현 ----

  // 뒤처진 카트 우대 가중치 지급
  _rollItem(kart, karts) {
    let maxProgress = -Infinity;
    for (const k of karts) {
      if (k.progress > maxProgress) maxProgress = k.progress;
    }
    const behind = (maxProgress - kart.progress); // 0이면 선두
    const isBehind = behind > 0.05; // 랩 진행도 기준 유의미하게 뒤처짐

    // [mushroom, shell, banana, star, balloon] 가중치 (각 합 1.00)
    const weights = isBehind
      ? [0.32, 0.18, 0.08, 0.26, 0.16]  // 뒤처짐: star/mushroom ↑
      : [0.22, 0.30, 0.24, 0.06, 0.18];
    let r = Math.random();
    for (let i = 0; i < ITEM_TYPES.length; i++) {
      r -= weights[i];
      if (r <= 0) return ITEM_TYPES[i];
    }
    return ITEM_TYPES[0];
  }

  _spawnShell(kart) {
    // 전방 = (-sin(heading), 0, -cos(heading)) — kart.js의 이동식과 동일한 규약
    const dir = new THREE.Vector3(-Math.sin(kart.heading), 0, -Math.cos(kart.heading));
    const mesh = new THREE.Mesh(this._shellGeo, this._shellMat);
    mesh.position.copy(kart.position);
    mesh.position.y = kart.position.y + SHELL_HEIGHT; // kart.position.y는 이미 노면 높이 (경사에서도)
    mesh.position.addScaledVector(dir, 1.8); // 카트 앞에서 시작 (자기 자신 피격 방지)
    this.scene.add(mesh);
    const speed = SHELL_SPEED + Math.max(0, kart.speed);
    // 힌트 시딩: 2층(오버패스) 맵에서 첫 프레임이 무힌트 전역 탐색이 되지 않도록
    // 발사 시점에 한 번만 전역 탐색해 자기 레벨의 인덱스를 물려준다(발사당 1회, 비용 무시 가능).
    const seed = this.track.sample(mesh.position);
    this.shells.push({
      mesh,
      velocity: dir.multiplyScalar(speed),
      owner: kart,
      life: SHELL_LIFETIME,
      _sampleHint: seed.index,
    });
  }

  _spawnBanana(kart) {
    // back은 이후 -2.2 배 되므로 여기엔 '전방' 벡터를 넣어야 최종적으로 후방이 된다
    const back = new THREE.Vector3(-Math.sin(kart.heading), 0, -Math.cos(kart.heading));
    back.multiplyScalar(-2.2); // 뒤쪽
    const mesh = new THREE.Mesh(this._bananaGeo, this._bananaMat);
    mesh.position.copy(kart.position).add(back);
    mesh.position.y = kart.position.y + 0.25; // kart.position.y는 노면 높이(경사 포함) — 그대로 따라온다
    this.scene.add(mesh);
    this.bananas.push({ mesh, owner: kart, armTimer: 0.6 }); // 설치 직후 주인 무시
  }

  _updateShells(dt, karts) {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.life -= dt;
      s.mesh.position.addScaledVector(s.velocity, dt);
      s.mesh.rotation.y += dt * 8;

      let dead = s.life <= 0;

      // 노면 밀착 + 벽 충돌: track.sample로 노면 높이 추종 및 횡방향 오프셋 검사
      // (전 프레임 인덱스를 힌트로 넘겨 국소 탐색 — 경사 맵에서 매 프레임 y를 갱신해
      // 언덕을 관통하지 않고 노면 위 SHELL_HEIGHT에 밀착시킨다. 평면 맵은 roadPoint.y가
      // 항상 0이라 기존과 동일하게 동작한다.)
      if (!dead) {
        const smp = this.track.sample(s.mesh.position, s._sampleHint);
        s._sampleHint = smp.index;
        s.mesh.position.y = smp.roadPoint.y + SHELL_HEIGHT;
        if (Math.abs(smp.lateral) > smp.halfWidth + 1.5) dead = true;
      }

      // 카트 충돌
      if (!dead) {
        for (const kart of karts) {
          if (kart === s.owner && s.life > SHELL_LIFETIME - 0.4) continue; // 발사 직후 주인 무시
          if (s.mesh.position.distanceTo(kart.position) < SHELL_HIT_RADIUS) {
            kart.spin(); // star 중이면 Kart가 무시
            dead = true;
            break;
          }
        }
      }

      if (dead) {
        this.scene.remove(s.mesh);
        this.shells.splice(i, 1);
      }
    }
  }

  _updateBananas(dt, karts) {
    for (let i = this.bananas.length - 1; i >= 0; i--) {
      const b = this.bananas[i];
      if (b.armTimer > 0) b.armTimer -= dt;
      b.mesh.rotation.y += dt * 1.5;
      let dead = false;
      for (const kart of karts) {
        if (kart === b.owner && b.armTimer > 0) continue;
        if (b.mesh.position.distanceTo(kart.position) < BANANA_HIT_RADIUS) {
          kart.spin();
          dead = true;
          break;
        }
      }
      if (dead) {
        this.scene.remove(b.mesh);
        this.bananas.splice(i, 1);
      }
    }
  }

  _spawnBalloon(kart) {
    // 전방 = (-sin(heading), 0, -cos(heading)) — kart.js의 이동식과 동일한 규약
    const dir = new THREE.Vector3(-Math.sin(kart.heading), 0, -Math.cos(kart.heading));
    const mesh = new THREE.Mesh(this._balloonGeo, this._balloonMat);
    mesh.position.copy(kart.position).addScaledVector(dir, 1.6);
    mesh.position.y += 1.0;
    this.scene.add(mesh);
    const vel = dir.clone().multiplyScalar(BALLOON_SPEED + Math.max(0, kart.speed) * 0.5);
    vel.y = BALLOON_UP;
    // 스폰 첫 프레임은 힌트가 없어 전역 탐색을 하는데, y를 포함한 비용으로 1회 미리 탐색해
    // 이후 프레임의 국소창(±25 샘플)이 처음부터 올바른 레벨에서 시작하게 한다(오버패스 대응).
    const seed = this.track.sample(mesh.position);
    this.balloons.push({ mesh, vel, owner: kart, life: BALLOON_LIFE, _sampleHint: seed.index });
  }

  _updateBalloons(dt, karts) {
    for (let i = this.balloons.length - 1; i >= 0; i--) {
      const b = this.balloons[i];
      b.life -= dt;
      b.vel.y -= BALLOON_G * dt;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.mesh.rotation.y += dt * 3;

      const smp = this.track.sample(b.mesh.position, b._sampleHint);
      b._sampleHint = smp.index;

      let dead = false;
      let landed = false; // true면 착탄지에 웅덩이를 남긴다(수명 초과만 예외)

      if (b.life <= 0) {
        dead = true;
      } else if (b.mesh.position.y <= smp.roadPoint.y + 0.25) {
        dead = true;
        landed = true;
      } else {
        for (const kart of karts) {
          if (kart === b.owner && b.life > BALLOON_LIFE - 0.3) continue; // 발사 직후 주인 무시
          if (b.mesh.position.distanceTo(kart.position) < BALLOON_HIT_R) {
            kart.applySlip(SLIP_DUR); // star 중이면 Kart가 무시
            dead = true;
            landed = true;
            break;
          }
        }
      }

      if (dead) {
        if (landed) this._spawnPuddle(b.mesh.position, b._sampleHint, b.owner);
        this.scene.remove(b.mesh);
        this.balloons.splice(i, 1);
      }
    }
  }

  // 착탄지에 경사 추종 웅덩이를 만든다. 평면 디스크로 두면 경사 노면에서 파묻히거나 뜨므로,
  // 정점마다 노면 높이를 직접 샘플링해 얹는다(생성 1회당 17회 — 무시 가능한 비용).
  _spawnPuddle(center, hintIndex, owner) {
    const geo = new THREE.CircleGeometry(PUDDLE_R, 16);
    geo.rotateX(-Math.PI / 2); // 수평(XZ)으로 눕혀 위(+Y)를 향하게
    const posAttr = geo.attributes.position;
    const v = new THREE.Vector3();
    let hint = hintIndex;
    for (let i = 0; i < posAttr.count; i++) {
      // y에 center.y를 넣어야 2층(오버패스) 맵에서 자기 레벨의 노면으로 스냅된다.
      // y=0으로 두면 데크 위 착탄이 아래층 노면 높이로 끌려 내려간다.
      v.set(posAttr.getX(i) + center.x, center.y, posAttr.getZ(i) + center.z);
      const smp = this.track.sample(v, hint);
      hint = smp.index;
      posAttr.setY(i, smp.roadPoint.y + 0.03 - center.y); // mesh.position.y = center.y 기준 상대 높이
    }
    posAttr.needsUpdate = true;
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: 0x3fb6e8,
      transparent: true,
      opacity: 0,
      depthWrite: false, // 노면과의 z-fighting 방지
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(center.x, center.y, center.z);
    this.scene.add(mesh);
    this.puddles.push({ mesh, life: PUDDLE_LIFE, age: 0, owner, ownerGrace: 0.5 });
  }

  _updatePuddles(dt, karts) {
    for (let i = this.puddles.length - 1; i >= 0; i--) {
      const p = this.puddles[i];
      p.age += dt;
      p.life -= dt;
      if (p.ownerGrace > 0) p.ownerGrace -= dt;

      // 페이드인 0.15s / 페이드아웃(남은 수명 1.0s 구간)
      const fadeIn = Math.min(1, p.age / 0.15);
      const fadeOut = Math.min(1, p.life / 1.0);
      p.mesh.material.opacity = 0.42 * Math.max(0, Math.min(fadeIn, fadeOut));

      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mesh.material.dispose();
        this.puddles.splice(i, 1);
        continue;
      }

      // 판정은 매 프레임 XZ 거리로: 웅덩이를 벗어난 시점부터 SLIP_DUR의 잔여 미끄러짐이 남는다.
      for (const kart of karts) {
        if (kart === p.owner && p.ownerGrace > 0) continue;
        const dx = kart.position.x - p.mesh.position.x;
        const dz = kart.position.z - p.mesh.position.z;
        // 2층 맵: 같은 XZ에 노면이 둘이므로 높이 차로 레벨을 갈라야 한다.
        // PUDDLE_LEVEL_DY(5m)는 오버패스 최소 수직 여유 11m의 절반보다 작고,
        // 웅덩이 반경 4.6m 안의 경사(최대 18%)+착탄 높이(~3m)보다 크다.
        if (Math.abs(kart.position.y - p.mesh.position.y) > PUDDLE_LEVEL_DY) continue;
        if (dx * dx + dz * dz < PUDDLE_TRIG_R * PUDDLE_TRIG_R) kart.applySlip(SLIP_DUR);
      }
    }
  }
}
