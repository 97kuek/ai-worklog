import * as THREE from "three";

const chairZ = 0.557;
const clamp = THREE.MathUtils.clamp;
const smooth = THREE.MathUtils.smoothstep;
const strideLength = 0.94;
const walkSpeed = 1.24;
const putDownTime = 0.82;
const seatTime = 0.85;
const walkStart = putDownTime + seatTime;
const rightAisle = 3.6;

function routeToDesk(cafe: THREE.Vector3, desk: THREE.Vector3) {
  const points = [
    new THREE.Vector3(cafe.x + 0.46, 0, cafe.z),
    new THREE.Vector3(cafe.x + 0.56, 0, -1.1),
    new THREE.Vector3(rightAisle, 0, -1.1),
    new THREE.Vector3(rightAisle, 0, 2.3),
    new THREE.Vector3(desk.x + 0.68, 0, 2.3),
    new THREE.Vector3(desk.x + 0.68, 0, desk.z + chairZ),
    new THREE.Vector3(desk.x + 0.32, 0, desk.z + chairZ),
  ];
  const route = new THREE.CurvePath<THREE.Vector3>();
  let from = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const corner = points[i];
    const radius = Math.min(0.24, corner.distanceTo(points[i - 1]) / 3, corner.distanceTo(points[i + 1]) / 3);
    const before = corner.clone().addScaledVector(points[i - 1].clone().sub(corner).normalize(), radius);
    const after = corner.clone().addScaledVector(points[i + 1].clone().sub(corner).normalize(), radius);
    route.add(new THREE.LineCurve3(from, before));
    route.add(new THREE.QuadraticBezierCurve3(before, corner, after));
    from = after;
  }
  route.add(new THREE.LineCurve3(from, points[points.length - 1]));
  return route;
}

const upperLeg = Math.hypot(0.277, 0.002);
const lowerLeg = Math.hypot(0.071, 0.494);
const seatedHip = Math.atan2(0.277, 0.002);
const seatedKnee = Math.atan2(0.071, 0.494);

// During stance the ankle travels back as far as the hips move forwards.
function ankleAt(phase: number) {
  const stance = 0.56;
  const reach = strideLength * stance / 2;
  if (phase < stance) return { forward: reach - phase * strideLength, lift: 0 };
  const u = (phase - stance) / (1 - stance);
  return {
    forward: -reach + strideLength * (smooth(u, 0, 1) - u * (1 - stance)),
    lift: 0.078 * Math.sin(Math.PI * u) ** 2,
  };
}

const drinks = [
  {name: "Coffee", ceramic: 0xe5956b, liquid: 0x372019},
  {name: "Tea", ceramic: 0x76b6ab, liquid: 0xb36527},
  {name: "Latte", ceramic: 0xf4dbac, liquid: 0xc39060},
];

function makeCup(slot: number) {
  const {name, ceramic, liquid} = drinks[slot];
  const cup = new THREE.Group();
  cup.name = name;
  const glaze = new THREE.MeshStandardMaterial({color: ceramic, roughness: 0.32});
  const profile = [[0, 0], [0.078, 0], [0.094, 0.015], [0.103, 0.171], [0.102, 0.179], [0.092, 0.179], [0.09, 0.158]];
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 24), glaze);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.051, 0.014, 8, 20), glaze);
  handle.name = "Handle";
  handle.position.set(0.112, 0.094, 0);
  handle.scale.y = 1.2;
  const surface = new THREE.Mesh(new THREE.CircleGeometry(0.093, 24), new THREE.MeshStandardMaterial({color: liquid}));
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = 0.162;
  cup.add(body, handle, surface);
  if (name === "Latte") {
    const foam = new THREE.Mesh(new THREE.RingGeometry(0.034, 0.045, 20), new THREE.MeshStandardMaterial({color: 0xffe5bd}));
    foam.rotation.x = -Math.PI / 2;
    foam.position.y = 0.163;
    foam.scale.y = 0.7;
    cup.add(foam);
  }
  return cup;
}

export class OfficeEmployee {
  readonly root = new THREE.Group();
  readonly cup: THREE.Group;
  private readonly route: THREE.CurvePath<THREE.Vector3>;
  private readonly length: number;
  private readonly walkEnd: number;
  private readonly duration: number;
  private readonly head: THREE.Object3D;
  private readonly limbs: {
    arm: THREE.Object3D; forearm: THREE.Object3D; thigh: THREE.Object3D; shin: THREE.Object3D; foot: THREE.Object3D;
  }[];
  private progress = 0;
  private velocity = 0;
  private direction = 1;
  private stride = 0;
  private cupLift = 0;
  private readonly shoulderToElbow: THREE.Vector3;
  private readonly elbowToHand = new THREE.Vector3(-0.115, 0.067, -0.33);
  private readonly reach = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly lowerAxis = new THREE.Vector3();
  private readonly upperRotation = new THREE.Quaternion();
  private readonly lowerRotation = new THREE.Quaternion();

  constructor(model: THREE.Object3D, private cafe: THREE.Vector3, desk: THREE.Vector3, private chair: THREE.Object3D, slot: number) {
    const figure = model.clone(true);
    figure.position.z = -chairZ;
    this.root.add(figure);
    this.head = figure.getObjectByName("Head")!;
    this.limbs = ["L", "R"].map(side => {
      const thigh = figure.getObjectByName("Thigh_" + side)!;
      const shin = figure.getObjectByName("Shin_" + side)!;
      const foot = figure.getObjectByName("Foot_" + side)!;
      const arm = figure.getObjectByName("Arm_" + side)!;
      const forearm = figure.getObjectByName("Forearm_" + side)!;
      thigh.attach(shin);
      shin.attach(foot);
      arm.attach(forearm);
      return { arm, forearm, thigh, shin, foot };
    });
    this.cup = makeCup(slot);
    this.shoulderToElbow = this.limbs[1].forearm.position.clone();
    this.route = routeToDesk(cafe, desk);
    this.length = this.route.getLength();
    this.walkEnd = walkStart + this.length / walkSpeed + 0.45;
    this.duration = this.walkEnd + seatTime;
    this.pose(0, slot * 2.1, false, false, true);
  }

  // Aim the upper arm and forearm so the right hand follows the handle through the sip.
  private holdCup(weight: number) {
    const {arm, forearm} = this.limbs[1];
    this.reach.set(0.15, 0.094, 0).applyQuaternion(this.cup.quaternion)
      .add(this.cup.position).sub(this.cafe).sub(arm.position);
    this.reach.z += chairZ;
    const upper = this.shoulderToElbow.length();
    const lower = this.elbowToHand.length();
    const length = clamp(this.reach.length(), lower - upper + 0.001, lower + upper - 0.001);
    this.aim.copy(this.reach).normalize();
    const along = (upper * upper - lower * lower + length * length) / (2 * length);
    this.elbow.set(0.75, -1, 0.3);
    this.elbow.addScaledVector(this.aim, -this.elbow.dot(this.aim)).normalize()
      .multiplyScalar(Math.sqrt(Math.max(0, upper * upper - along * along))).addScaledVector(this.aim, along);
    this.upperRotation.setFromUnitVectors(this.aim.copy(this.shoulderToElbow).normalize(), this.lowerAxis.copy(this.elbow).normalize());
    this.lowerRotation.copy(this.upperRotation).invert();
    this.aim.copy(this.reach).sub(this.elbow).applyQuaternion(this.lowerRotation).normalize();
    this.lowerRotation.setFromUnitVectors(this.elbow.copy(this.elbowToHand).normalize(), this.aim);
    arm.quaternion.slerp(this.upperRotation, weight);
    forearm.quaternion.slerp(this.lowerRotation, weight);
  }

  pose(delta: number, phase: number, working: boolean, reduced: boolean, immediate = false) {
    const previous = this.progress;
    const goal = working ? this.duration : 0;
    if (reduced || immediate) {
      this.progress = goal;
      this.velocity = 0;
      this.root.rotation.y = 0;
    } else {
      const targetVelocity = Math.sign(goal - this.progress);
      this.velocity += clamp(targetVelocity - this.velocity, -delta * 3.2, delta * 3.2);
      this.progress = clamp(this.progress + this.velocity * delta, 0, this.duration);
      if (this.progress === goal) this.velocity = 0;
    }
    const time = clamp(this.progress - walkStart, 0, this.walkEnd - walkStart);
    const left = this.walkEnd - walkStart - time;
    const ramp = 0.45;
    let distance = walkSpeed * (time - ramp / 2);
    if (time < ramp) distance = walkSpeed * time * time / (2 * ramp);
    else if (left < ramp) distance = this.length - walkSpeed * left * left / (2 * ramp);
    const transit = this.progress > walkStart && this.progress < this.walkEnd;
    const cafeSit = 1 - smooth(this.progress, putDownTime, walkStart);
    const deskSit = smooth(this.progress, this.walkEnd, this.duration);
    const stand = 1 - cafeSit - deskSit;
    const fraction = clamp(distance / this.length, 0, 1);
    this.route.getPoint(fraction, this.root.position);
    this.root.position.x -= 0.46 * cafeSit + 0.32 * deskSit;

    // Turn through the shorter arc even when a status poll reverses the walk in an aisle.
    if (this.velocity) this.direction = Math.sign(this.velocity);
    if (transit) {
      const tangent = this.route.getTangent(fraction);
      const angle = Math.atan2(-tangent.x * this.direction, -tangent.z * this.direction);
      this.turn(angle, delta);
    } else this.turn(0, delta);
    const speed = Math.min(1, time / ramp, left / ramp) * Math.abs(this.velocity);
    this.stride += delta * walkSpeed * speed / strideLength;
    const beat = 2 * Math.PI * this.stride;
    const amplitude = smooth(distance, 0, 0.32) * smooth(this.length - distance, 0, 0.32) * speed;
    const rise = (0.057 + amplitude * 0.012 * Math.cos(2 * beat)) * stand;
    this.root.position.y += rise;
    this.chair.position.z = 0.59 + 0.2 * (1 - smooth(this.length - distance, 0.25, 1.1)) * stand;

    const sip = reduced ? 0.75 : smooth(Math.sin(phase * 0.98), -0.55, 0.78);
    const liftTarget = (0.28 + 0.72 * sip) * (1 - smooth(this.progress, 0, putDownTime * 0.76));
    if (reduced || immediate) this.cupLift = liftTarget;
    else this.cupLift += clamp(liftTarget - this.cupLift, -delta * 2.2, delta * 1.65);
    // The cup's origin is the base. It stays on the cafe counter for the whole shift.
    this.cup.position.copy(this.cafe);
    this.cup.position.x += 0.045 + 0.18 * this.cupLift;
    this.cup.position.y += 1.08 + 0.34 * this.cupLift;
    this.cup.position.z += -0.57 + 0.17 * this.cupLift;
    this.cup.rotation.x = smooth(this.cupLift, 0.58, 1) * 0.56;
    this.cup.rotation.z = smooth(this.cupLift, 0.58, 1) * 0.29;
    this.head.rotation.x = 0.07 * stand + 0.06 * this.cupLift;
    this.head.rotation.z = reduced ? 0 : 0.012 * Math.sin(phase * 1.6);
    this.limbs.forEach(({arm, forearm, thigh, shin, foot}, side) => {
      const ankle = ankleAt((this.stride + side / 2) % 1);
      const forward = 0.035 + ankle.forward * amplitude;
      const drop = 0.737 + rise - (0.0895 + ankle.lift * amplitude);
      const reach = Math.hypot(forward, drop);
      const hip = Math.atan2(forward, drop) +
        Math.acos(clamp((reach * reach + upperLeg ** 2 - lowerLeg ** 2) / (2 * reach * upperLeg), -1, 1));
      const knee = Math.atan2(forward - upperLeg * Math.sin(hip), drop - upperLeg * Math.cos(hip));
      thigh.rotation.x = (hip - seatedHip) * stand;
      shin.rotation.x = (knee - seatedKnee) * stand - thigh.rotation.x;
      foot.rotation.x = -thigh.rotation.x - shin.rotation.x;
      const swing = Math.cos(beat + side * Math.PI) * amplitude;
      const typing = reduced ? 0 : 0.032 * Math.sin(phase * 6.8 + side * 2);
      arm.rotation.set((-0.83 - swing * 0.21) * stand + typing * deskSit - 0.27 * cafeSit, 0, 0);
      forearm.rotation.set(-0.60 * stand + typing * deskSit, 0, 0);
    });
    const grip = 1 - smooth(this.progress, putDownTime * 0.81, putDownTime + 0.24);
    if (grip) this.holdCup(grip);
    return previous !== this.progress;
  }

  private turn(target: number, delta: number) {
    const angle = target - this.root.rotation.y;
    const shortest = Math.atan2(Math.sin(angle), Math.cos(angle));
    this.root.rotation.y += clamp(shortest, -5.2 * delta, 5.2 * delta);
  }
}
