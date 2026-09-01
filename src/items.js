// src/items.js — 아이템 박스, 픽업/지급, 아이템 효과 (mushroom/shell/banana/star)
import * as THREE from 'three';

const BOX_RESPAWN = 3;      // 초
const PICKUP_RADIUS = 1.6;  // m
const SHELL_SPEED = 25;     // m/s (+ 사용자 속도)
const SHELL_RADIUS = 0.45;
const SHELL_HIT_RADIUS = 1.2;
const SHELL_LIFETIME = 6;   // 초 (안전장치)
const BANANA_HIT_RADIUS = 1.1;
const ITEM_TYPES = ['mushroom', 'shell', 'banana', 'star'];

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

    // 아이템 박스 생성
    this.boxes = [];
    const positions = (track && track.itemBoxPositions) || [];
    for (const p of positions) {
      const mesh = new THREE.Mesh(this._boxGeo, this._boxMat);
      mesh.position.copy(p); // track.itemBoxPositions가 이미 y=1.0으로 띄워서 준다
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
  }

  // 맵 전환 시 main이 호출: 씬에 add한 것 전부 제거 + 자체 생성 GPU 리소스 해제.
  // (지오메트리/머티리얼은 전부 이 클래스가 만든 것이라 dispose 대상이다)
  dispose() {
    for (const box of this.boxes) this.scene.remove(box.mesh);
    for (const s of this.shells) this.scene.remove(s.mesh);
    for (const b of this.bananas) this.scene.remove(b.mesh);
    this.boxes.length = 0;
    this.shells.length = 0;
    this.bananas.length = 0;

    this._boxGeo.dispose();
    this._boxMat.dispose();
    this._shellGeo.dispose();
    this._shellMat.dispose();
    this._bananaGeo.dispose();
    this._bananaMat.dispose();
  }

  update(dt, karts) {
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
        // 박스는 도로 위 1m에 떠 있고 카트 원점은 노면(y=0)이므로 수평거리로 판정한다.
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
  }

  use(kart, allKarts) {
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

    // [mushroom, shell, banana, star] 가중치
    const weights = isBehind
      ? [0.38, 0.22, 0.10, 0.30]  // 뒤처짐: star/mushroom ↑
      : [0.25, 0.35, 0.32, 0.08];
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
    mesh.position.y += 0.4;
    mesh.position.addScaledVector(dir, 1.8); // 카트 앞에서 시작 (자기 자신 피격 방지)
    this.scene.add(mesh);
    const speed = SHELL_SPEED + Math.max(0, kart.speed);
    this.shells.push({
      mesh,
      velocity: dir.multiplyScalar(speed),
      owner: kart,
      life: SHELL_LIFETIME,
      _sampleHint: undefined,
    });
  }

  _spawnBanana(kart) {
    // back은 이후 -2.2 배 되므로 여기엔 '전방' 벡터를 넣어야 최종적으로 후방이 된다
    const back = new THREE.Vector3(-Math.sin(kart.heading), 0, -Math.cos(kart.heading));
    back.multiplyScalar(-2.2); // 뒤쪽
    const mesh = new THREE.Mesh(this._bananaGeo, this._bananaMat);
    mesh.position.copy(kart.position).add(back);
    mesh.position.y = kart.position.y + 0.25;
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

      // 벽 충돌: track.sample로 횡방향 오프셋 검사 (전 프레임 인덱스를 힌트로 넘겨 국소 탐색)
      if (!dead) {
        const smp = this.track.sample(s.mesh.position, s._sampleHint);
        s._sampleHint = smp.index;
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
}
