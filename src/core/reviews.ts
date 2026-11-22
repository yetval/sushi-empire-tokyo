// Tabelog-style customer reviews: phrase tables + a tiny composer. Pure logic, deterministic via sim.setRandom().
import { CUSTOMERS, CustomerType, RECIPES } from './data';
import { rand } from './sim';
import { GameState } from './state';

export interface Review { stars: number; author: string; text: string; day: number }

interface Voice { open: [bad: string[], mid: string[], good: string[]]; sign: string[]; handle: string[] }

const VOICES: Record<CustomerType, Voice> = {
  student: {
    open: [
      ['bro. what was that.', 'lowkey regret spending my ramen budget here.', "this ain't it, chief."],
      ['it was mid tbh.', 'decent. not life-changing, ngl.', 'fine for a study break i guess.'],
      ['yo this slaps fr fr.', 'ok bestie this place is bussin.', 'no cap, top tier eats for broke people.'],
    ],
    sign: ['gonna tell the whole dorm.', 'rating based on vibes only.', 'back to cramming. bye.'],
    handle: ['ramen_ninja', 'NoCapKenji', 'dorm_rat'],
  },
  office: {
    open: [
      ['My boss yelled at me and then this happened.', 'I came here to escape the office. It felt like the office.', 'Somehow worse than the overtime.'],
      ['Ate it at my desk. It was food.', 'Acceptable. Like my performance review.', 'Neither good nor bad. Much like Tuesday.'],
      ['After a 14-hour day this almost made me feel human.', 'Finally, something good happened today.', 'Better than my bonus. Which was nothing.'],
    ],
    sign: ['Back to the spreadsheet.', 'The last train waits for no one.', 'Will return if I ever get a lunch break.'],
    handle: ['SalarymanTaro', 'OvertimeHiro', 'LastTrainKen'],
  },
  tourist: {
    open: [
      ['Hmm, the guidebook oversold this one.', 'Not the Japan experience I saw on TV.', 'My phone took better photos than the food deserved.'],
      ['Pretty good! Hard to compare, everything here is new!', 'Nice! Not sure I used the chopsticks right.', 'Decent stop between temples!'],
      ['OMG my first real sushi in Tokyo!!!', 'Best day of the whole trip, hands down!', 'I cried a little. Japan is magic!'],
    ],
    sign: ['Already planning my next trip!', 'Arigato!! (did I spell that right?)', 'Took 200 photos. Worth it.'],
    handle: ['WanderlustJess', 'backpack_bob', 'TokyoFirstTimer'],
  },
  family: {
    open: [
      ['Two kids, three meltdowns, zero smiles.', 'My son traded his sushi for a napkin.', 'Grandma has opinions now. Many opinions.'],
      ['Kids liked half of it, we liked the other half.', 'Fine for a family night. Nobody cried.', 'Okay. The little one mostly ate rice.'],
      ['The kids ate everything without a single complaint. A miracle!', 'Grandma approved. That never happens.', 'Whole family left smiling and full.'],
    ],
    sign: ['Bring wet wipes.', 'Will return when the kids forget.', 'Parent of three, tired but honest.'],
    handle: ['MamaYuko', 'PapaSan', 'FamilyTanaka'],
  },
  foodie: {
    open: [
      ['The rice was compressed like a rush-hour train.', 'Fish this tired should be on vacation.', 'I have notes. Pages of them.'],
      ['Competent, though the vinegar lacked conviction.', 'Solid fundamentals, timid seasoning.', 'Promising, but the rice was a degree too cold.'],
      ['The rice temperature alone deserves a sonnet.', 'A rare kitchen that respects the fish.', 'Balance, acidity, texture: all present and correct.'],
    ],
    sign: ['Full tasting notes on my blog.', 'Visited anonymously, as always.', 'Will re-evaluate next season.'],
    handle: ['umami_hunter', 'RiceWhisperer', 'shari_scholar'],
  },
  wealthy: {
    open: [
      ["I've tipped more than this meal was worth.", 'My driver ate better in the car.', 'Disappointing. I shall inform my club.'],
      ["Adequate. I've had worse in first class.", 'Pleasant enough between board meetings.', 'Charming, in a modest sort of way.'],
      ['Delightful. I may buy the building.', 'Nearly as good as my private chef. Nearly.', "My yacht's sushi bar has competition."],
    ],
    sign: ['Sent my assistant to type this.', 'Ciao, darlings.', 'Money is no object. Taste is.'],
    handle: ['GinzaGoldCard', 'Mr_Moneybags', 'PlatinumPenthouse'],
  },
  influencer: {
    open: [
      ['Unfollowing this restaurant IRL 💀', 'The lighting was SO bad my ring light gave up 😤', 'Not sponsored and now I know why 🙃'],
      ["It's giving... okay 🤷", 'Cute plates, mid lighting 📸', 'Vibes were a solid 6/10 ngl ✨'],
      ['OMG obsessed 😍✨ THE spot rn!!', "Literally crying it's so aesthetic 😭💕", 'Content AND flavor?? iconic 🔥🔥'],
    ],
    sign: ['{tag} #sushitime #tokyoeats', 'Link in bio 💅 {tag}', '#foodie #notanad {tag}'],
    handle: ['sushi.queen', 'BentoBabe', 'Riko_vlogs'],
  },
  critic: {
    open: [
      ['A meal I shall spend years forgetting.', 'One admires the ambition, if not the result.', 'The menu promises a sonata; the plate delivers a car alarm.'],
      ['A competent performance lacking a second act.', 'Pleasant, forgettable, and aware of neither.', 'The kitchen hums but never quite sings.'],
      ["One leaves {place} quietly convinced of the chef's genius.", 'A meal of rare, almost impertinent, confidence.', 'Here, at last, is cooking with a point of view.'],
    ],
    sign: ["Full review in Sunday's edition.", 'Filed from my usual corner table.', 'I remain, as ever, unmoved by the music.'],
    handle: ['TheGourmand', 'Critic_Kurosawa', 'PenAndPalate'],
  },
  vip: {
    open: [
      ['I expected a private room. I got a stool.', 'My publicist will be in touch.', 'Unacceptable. Do you know who I am?'],
      ['Adequate for someone of my standing.', 'The red carpet was missing. The food was fine.', 'Fine. My bodyguard enjoyed it more than I did.'],
      ['My entourage approves.', 'Treated like royalty, as is customary.', 'Exquisite. Tell the chef he may keep his job.'],
    ],
    sign: ['No autographs, please.', 'Arrived by helicopter, left by limousine.', 'My people will call your people.'],
    handle: ['ThePrince', 'MysteryVIP', 'Sakura_Celebrity'],
  },
};

const FOOD: [bad: string[], mid: string[], good: string[]] = [
  ['The {dish} tasted like it lost an argument.', "{n} pieces of {dish} and not one I'd recommend.", 'The {dish} fell apart before I could.', "Pretty sure the {dish} was yesterday's {dish}.", 'That {dish} was more nori than joy.'],
  ['The {dish} was fine. Just fine.', '{n} pieces of {dish}: inoffensive, all of them.', 'The {dish} did its job, no overtime.', 'Solid {dish}, nothing to write home about.', 'The {dish} was okay but shy.'],
  ['The {dish} was outrageously good.', "I'd fight a crow for another {dish}.", '{n} pieces of {dish} vanished in seconds.', 'That {dish} deserves its own fan club.', "The {dish} melted like a pop idol's heart."],
];

const DETAIL = {
  takeout: ['Ate it on the train home, still good.', 'Takeout bag survived the bike ride, mostly.', 'Box arrived intact. Chopsticks did not.', 'Ate it straight from the box on my sofa.'],
  slow: ['Waited so long I aged a year.', 'The wait was longer than my commute.', 'Learned a new language while waiting.', '{place} must be cooking each grain individually.'],
  fast: ['Food landed in record time!', 'Served faster than a bullet train.', 'Blinked and my order was there.', 'Speedy kitchen at {place}.'],
  pricey: ['Prices made my wallet cry.', "Pretty sure I paid for the chef's car.", 'Bring a second credit card to {place}.', 'Did they price this in dollars by mistake?'],
  bargain: ['Cheap enough to come back tomorrow.', 'Absolute steal for the price.', 'Prices from a kinder century.', 'My wallet sends its thanks to {place}.'],
  dirty: ['The floor was sticky in a personal way.', 'Saw a napkin from last week. Hi, napkin.', '{place} could use a mop and a pep talk.', 'Table had a souvenir from the last guest.'],
  clean: ["So clean I could eat off the floor (didn't).", 'Spotless counters, very relaxing.', '{place} gleamed like a showroom.', 'Cleaner than my apartment, honestly.'],
  generic: ['Nice little spot, {place}.', '{place} has charm.', 'Found {place} by accident.', '{place}: worth a look.'],
};

const HANDLE_SUFFIX = ['_88', '_tokyo', '2003', '_san', '_jp', '77', '_desu', '', '_x', '99'];

/** Every phrase fragment (for tests / stats). */
export const PHRASES: string[] = [
  ...Object.values(VOICES).flatMap((v) => [...v.open.flat(), ...v.sign, ...v.handle]),
  ...FOOD.flat(), ...Object.values(DETAIL).flat(), ...HANDLE_SUFFIX,
];

export const MAX_REVIEW_LEN = 220;

/** Build one review for a settled sale. waitSec null = takeout. */
export function makeReview(
  s: GameState, restId: string,
  sale: { customerType: CustomerType; recipe: string; pieces: number; satisfaction: number; waitSec: number | null },
  rng: () => number = rand,
): Review {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rng() * a.length)];
  const r = s.restaurants[restId], def = CUSTOMERS[sale.customerType], voice = VOICES[sale.customerType];
  const stars = Math.max(1, Math.min(5, Math.round(sale.satisfaction * 5 + 0.5 + (rng() - 0.5) * 1.2)));
  const tier = stars >= 4 ? 2 : stars === 3 ? 1 : 0;

  const details: (keyof typeof DETAIL)[] = [];
  if (sale.waitSec === null) details.push('takeout');
  else if (sale.waitSec > def.patience * 0.7) details.push('slow');
  else if (sale.waitSec < def.patience * 0.25) details.push('fast');
  if (r.priceMult > def.priceTolerance + 0.15) details.push('pricey');
  else if (r.priceMult < def.priceTolerance - 0.4) details.push('bargain');
  if (r.cleanliness < 0.5) details.push('dirty');
  else if (r.cleanliness > 0.9) details.push('clean');
  if (!details.length) details.push('generic');
  const first = pick(details), second = pick(details);

  const vars: Record<string, string> = {
    dish: RECIPES[sale.recipe]?.name ?? 'sushi', n: String(sale.pieces), place: r.name,
    tag: '#' + r.name.replace(/[^\p{L}\p{N}]/gu, ''),
  };
  const parts = [pick(voice.open[tier]), pick(FOOD[tier]), pick(DETAIL[first]), second !== first ? pick(DETAIL[second]) : '', pick(voice.sign)];
  const text = parts.filter(Boolean).map((p) => p.replace(/\{(\w+)\}/g, (_, k: string) => vars[k]))
    .reduce((acc, p) => (acc.length + 1 + p.length <= MAX_REVIEW_LEN ? acc + ' ' + p : acc));
  return { stars, author: pick(voice.handle) + pick(HANDLE_SUFFIX), text, day: s.day };
}

/** Ring buffer, NEWEST FIRST: returns a new array with r at index 0, trimmed to cap. */
export function pushReview(list: Review[], r: Review, cap = 50): Review[] {
  return [r, ...list].slice(0, cap);
}

export function averageStars(list: Review[]): number {
  return list.length ? list.reduce((a, r) => a + r.stars, 0) / list.length : 0;
}
