// Game geometry and physics constants (from the bridge spec and game source).

export const ARENA_W = 480;
export const CAT_Y = 536; // cat baseline (state.cat.y)
export const MUZZLE_Y = CAT_Y - 16; // furball spawn height = 520
export const MUZZLE_OFFSET = 18; // furball spawns at cat.x + 18
export const FURBALL_SPEED = 430; // px/s, upward
export const CAT_GLIDE_SPEED = 322; // moveTo speed (1.4 x keyboard 230)
export const CAT_MIN_X = 36;
export const CAT_MAX_X = 444;
export const CAT_HALF_WIDTH = 30; // cat hitbox is cat.x +/- 30
export const CAT_HIT_TOP = 502; // hitbox band 502..536
export const SHIELD_Y = 392; // all shields sit at this height
export const MARCH_STEP_X = 12; // horizontal march step of the formation
export const MARCH_DROP_Y = 16; // vertical drop on wall contact
