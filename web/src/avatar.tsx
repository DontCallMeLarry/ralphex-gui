import { Avatar, Style } from '@dicebear/core';
// DiceBear "sprouts" style, bundled locally — no runtime calls to api.dicebear.com (FR-3.3).
import sproutsDefinition from '@dicebear/styles/sprouts.json' with { type: 'json' };
import type { Stage } from './api.ts';

const style = new Style(sproutsDefinition as ConstructorParameters<typeof Style>[0]);

/**
 * The pane behind each plant, left to the style's own twelve backgrounds: deep,
 * saturated jewel tones — sky, indigo, violet, fuchsia, rose, amber, emerald,
 * teal, slate. Everything else in the style is drawn to sit on them. Pots are
 * pale, plants are bright green, faces are near-black ink.
 *
 * Overriding them with a soft palette is what made the gradient look broken:
 * `linear` fill takes two stops from whatever palette it is given, so gentle
 * tints produce a technically correct gradient between two colours nobody can
 * tell apart. The saturated defaults are what make violet→rose or amber→slate
 * actually read. The angle sits roughly top-to-bottom (90° is straight down),
 * with enough play that a shelf of specimens isn't lit by one flat lamp.
 */
const BACKGROUND_ANGLE: [number, number] = [70, 130];

/**
 * The plant never changes — only how close the glass is. One seed grows through
 * all four stages by scaling up while the frame slides, so the camera walks
 * from a young sprout sitting low in its pot to a canopy that overflows the
 * pane: by the time a specimen is ready to prune you are looking at its leaves.
 *
 * Scale is applied about the centre before the translate, so `translateY` is a
 * straight percentage of the pane regardless of how far in we've zoomed.
 */
type Framing = { scale: number; translateY: number };

const FRAMING: Record<Stage, Framing> = {
  seedling: { scale: 0.8, translateY: 20 },
  growing: { scale: 1.25, translateY: 0 },
  budding: { scale: 1.75, translateY: -20 },
  ready: { scale: 2.25, translateY: 20 },
};

/**
 * Two variants are held back from the everyday pool — `round` eyes and the
 * `frown` mouth — so that a specimen wearing them means something. They are
 * spent in one place: the prune dialog, where the plant you are about to
 * remove looks up at you.
 *
 * The PRNG is key-based rather than a sequential stream, so narrowing the eye
 * and mouth pools moves nothing else. Same seed, same plant, same pot, same
 * colours — only the face changes.
 */
type Face = { eyesVariant: string[]; mouthVariant: string[] };

function variantsExcept(component: string, held: string): string[] {
  const variants = style.components().get(component)?.variants();
  return variants ? [...variants.keys()].filter((name) => name !== held) : [];
}

const EVERYDAY_FACE: Face = {
  eyesVariant: variantsExcept('eyes', 'round'),
  mouthVariant: variantsExcept('mouth', 'frown'),
};

const PLEADING_FACE: Face = { eyesVariant: ['round'], mouthVariant: ['frown'] };

/**
 * Every animated variant in the style definition carries weight 0, so a plant
 * left to chance always comes out `none` — perfectly still. Terrarium wants
 * living plants, so the speed is drawn from these instead: seeded like every
 * other trait, which keeps a shelf of them from swaying in unison. `fastest` is
 * left out; anything quicker than `fast` reads as fidgeting.
 *
 * The variants gate their own keyframes behind `prefers-reduced-motion`, and
 * that resolves against the host document even from inside an `<img>`, so a
 * developer who asked the OS for stillness gets a static terrarium.
 */
const ANIMATION_SPEEDS = ['fast', 'medium', 'slow', 'slowest'];

const cache = new Map<string, string>();

function dataUri(seed: string, variety: string, framing: Framing, face: Face, animated: boolean): string {
  const key = `${seed}:${variety}${animated ? '' : ':still'}`;
  let uri = cache.get(key);
  if (!uri) {
    uri = new Avatar(style, {
      seed,
      scale: framing.scale,
      translateY: framing.translateY,
      ...face,
      backgroundColorFill: 'linear',
      backgroundColorAngle: BACKGROUND_ANGLE,
      animationVariant: animated ? ANIMATION_SPEEDS : ['none'],
    }).toDataUri();
    cache.set(key, uri);
  }
  return uri;
}

export function sproutDataUri(seed: string, stage: Stage, animated = true): string {
  return dataUri(seed, stage, FRAMING[stage], EVERYDAY_FACE, animated);
}

/**
 * The same specimen, one bad afternoon: round eyes and a frown. The camera
 * stays pulled back — zooming in cropped the very face this exists to show,
 * so the whole plant sits in frame, crying visibly, pot and all.
 */
const PLEADING_FRAMING: Framing = { scale: 1.05, translateY: 5 };

export function pleadingDataUri(seed: string, animated = true): string {
  return dataUri(seed, 'pleading', PLEADING_FRAMING, PLEADING_FACE, animated);
}

export function SproutAvatar({
  seed,
  stage,
  size = 56,
  title,
  animated = true,
}: {
  seed: string;
  stage: Stage;
  size?: number;
  title?: string;
  animated?: boolean;
}) {
  return (
    <img
      className="sprout-avatar"
      src={sproutDataUri(seed, stage, animated)}
      width={size}
      height={size}
      alt=""
      title={title}
      draggable={false}
    />
  );
}

export function PleadingSprout({ seed, size = 64 }: { seed: string; size?: number }) {
  return (
    <img
      className="sprout-avatar"
      src={pleadingDataUri(seed)}
      width={size}
      height={size}
      alt=""
      draggable={false}
    />
  );
}
