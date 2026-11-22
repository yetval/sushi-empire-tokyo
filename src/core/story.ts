// Story NPC dialogue and one-shot story beats, chosen from game progress. Pure logic.
import { GameState } from './state';

export type StoryNpcId = 'kenji' | 'mika' | 'sato' | 'ryo' | 'aoki';
export interface StoryBeat { id: string; speaker: string; lines: string[] }

function context(s: GameState) {
  const rests = Object.values(s.restaurants);
  return {
    name: s.player.name,
    p: s.lifetime.pieces,
    n: rests.length,
    stars: rests.length ? rests.reduce((a, r) => a + r.reputation, 0) / rests.length : 0,
    districts: s.districts.length,
    ginza: s.districts.includes('ginza'),
    shibuya: s.districts.includes('shibuya'),
    ch2: !!s.flags.chapter2,
    cities: Object.values(s.cities).filter((c) => c.open).length,
    night: s.minute >= 22 * 60 || s.minute < 5 * 60,
    morning: s.minute >= 5 * 60 && s.minute < 10 * 60,
    staff: s.staff.length,
  };
}

// First matching rule wins; each list ends with an always-true fallback.
type Rule = [boolean, string[]];
const pick = (rules: Rule[]) => rules.find(([ok]) => ok)![1];

export function dialogueFor(npcId: StoryNpcId, s: GameState): string[] {
  const c = context(s);
  switch (npcId) {
    case 'kenji': return pick([
      [c.p >= 100_000_000, ['A hundred million pieces. I used to count the day\'s orders on the back of a paper bag.', 'Keep a seat at the old counter for me, will you?']],
      [c.ch2 && c.cities > 1, ['My wife used to say our rice wouldn\'t travel as far as Ueno. I wish she could see the map now.', 'Send me a postcard from the first shop you visit.']],
      [c.ch2, [`A million pieces, ${c.name}. I still remember the first one you put down at that counter.`, 'That\'s enough counting for one evening. Come sit with me a minute.']],
      [c.night, ['You\'re still here? I could see your light from the station.', 'Put the fish away and give your feet a rest.']],
      [c.ginza, ['I once rode a delivery to Ginza. A doorman sent me round the back without even looking at the box.']],
      [c.n > 3, [`${c.n} restaurants! When I opened this stand I could barely afford rice.`, 'Who will close the stand when you\'re across town?']],
      [c.p > 1000, ['The neighbor from the stationery shop asked if you\'d be open for lunch tomorrow.', 'That\'s when I\'d look for a second pair of hands.']],
      [c.staff === 0, ['Nobody cooks for free, not even family. Hire a chef and the stand will open itself.', 'Pick someone with steady hands. Skill shows in the rice.']],
      [true, ['Your chef squeezes the rice just right. I had a look when they weren\'t watching.', 'If people are standing a while, that counter needs a server.']],
    ]);
    case 'mika': return pick([
      [c.p >= 10_000_000, ['Ten million. I had to paint your name on another van.', 'If you see one parked outside the stand, that\'s your salmon. I\'m probably having lunch.']],
      [c.ch2, ['I used to fit your order in one ice box. Now I\'ve got two vans on your route.']],
      [c.morning, ["Morning. The salmon\'s just off the truck. I\'ve put yours on ice."]],
      [c.night, ['Mika\'s Fresh Fish is closing up. I can sell you ice, a mop, or my sympathy.']],
      [c.n > 2, ['Your kitchens tell me what they used, I bring it the next morning. You just get the bill.']],
      [c.districts > 1, ['I\'ve got room on the scooter for your other shop too. Same price as here.']],
      [true, ['Your chef already called in today\'s order. Salmon, rice, nori, the usual.', 'You pay for what they use, at market price. No fridge full of fish going off.']],
    ]);
    case 'sato': return pick([
      [c.ch2 && c.cities > 1, ['Each city gets its own ledger. That\'s how you\'ll see which franchises are paying their way.', 'Check the royalties once a day. You\'ll see more than you would staring at the till.']],
      [c.ch2, ['Congratulations. Bring me the figures from your busiest shop tomorrow. We can use them to price a franchise.']],
      [c.night, ['It is late. I am billing you for this conversation at the night rate.']],
      [c.districts >= 3, ['Compare the rent with the takings at each shop. A full room in Shibuya can make less than a quiet one in Asakusa.']],
      [c.n > 3, ['It takes time to cross town. Put a manager in the shop you can least afford to leave unattended.']],
      [c.p > 5000, ['Look at which station holds up service. That\'s where I\'d spend the next yen.']],
      [true, ['Sato. Show me where the queue backs up and I\'ll tell you where to spend.', 'If the kitchen is already behind, hold off on advertising.']],
    ]);
    case 'ryo': return pick([
      [c.ch2, ['A million. I saw the paper. Don\'t tell anyone I bought a copy.']],
      [c.shibuya, ['I took my lunch past your place in Shibuya. Your line was longer than mine. Today.']],
      [c.p >= 1000, ['That\'s my red sign across the street. I put it where people would see it from your queue.']],
      [c.night, ['Hear that rattle? I\'ve been chasing it round the same belt all night.']],
      [true, ['Ryo Tanaka. I run the conveyor place across the street.', 'Two minutes from door to plate at lunch. Your turn.']],
    ]);
    case 'aoki': return pick([
      [c.ch2 && c.cities > 1, ['I hear you have gone international. I shall be visiting. Unannounced, naturally.']],
      [c.ch2, ['Someone told me a million. I went back to see if the rice was still as good. It was.']],
      [c.stars >= 4.5, ['I sent a friend last week. She described the same piece I had. That matters.']],
      [c.ginza, ['In Ginza I can get good fish on any block. Give me a reason to come back to yours.']],
      [c.night, ['I like to come for the last order. It tells me what the kitchen is like when the owner\'s gone home.']],
      [c.p >= 2000, ['I\'ll be back in a few weeks. That\'s long enough to see what\'s changed.']],
      [true, ['Aoki. I\'ll have whichever nigiri the chef ate for lunch.', 'You can leave the menu. I\'ll ask when I\'m ready.']],
    ]);
  }
}

/** Returns the next unseen story beat (marking it seen in s.flags), or null. Order = priority. */
export function checkStoryBeat(s: GameState): StoryBeat | null {
  const c = context(s);
  const beats: [string, string, boolean, string[]][] = [
    ['kenji_million', 'Grandpa Kenji', c.p >= 1_000_000, [
      `${c.name}, I counted twice. A million.`,
      'I thought I’d be the last person to turn the lights off in that stand. Thank you for keeping them on.',
      'Come open with me tomorrow. I’ll put the rice on.']],
    ['ryo_rival', 'Ryo Tanaka', c.p >= 1000, [
      'I asked a regular why he’d stopped coming to my shop. He said he was eating here.',
      'I’m Ryo, from Kaiten King across the street. I’ll try your salmon before I change my prices.']],
    ['mika_regular', 'Mika', c.p >= 500, [
      'I’ve started keeping a box with your name on it. Kenji used to make me split one with him.',
      'Put a little salmon aside when the delivery comes. You’ll want it at the end of the dinner rush.']],
    ['aoki_review', 'Madame Aoki', c.p >= 2000, [
      'The salmon was good. The rice had cooled by the time it reached me.',
      'Three stars. Give me a reason to order a second piece next time.']],
    ['second_shop', 'Grandpa Kenji', c.n >= 2, [
      'Two sets of keys now. Mark them before you walk home with the wrong ones.']],
    ['sato_intro', 'Mr. Sato', c.p >= 5000, [
      'Sato. I’ve been looking at your lunch receipts.',
      'Work out what you’re making per seat before you start paying for more seats.']],
    ['aoki_ginza', 'Madame Aoki', c.ginza, [
      'I dine in Ginza once a week. I’ll make your shop the next stop.',
      'Send out whatever you’re proudest of that day. I’ll leave the order to you.']],
    ['sato_world', 'Mr. Sato', c.cities > 1, [
      'You’ve got two cities now. Eat at both before you open a third.']],
    ['mika_fleet', 'Mika', c.p >= 10_000_000, [
      'I picked up truck number fifty this morning. I still have the bicycle I started on.',
      'It’s parked out back. Come by for tea when you’ve a minute.']],
  ];
  const hit = beats.find(([id, , ok]) => ok && !s.flags['story_' + id]);
  if (!hit) return null;
  s.flags['story_' + hit[0]] = true;
  return { id: hit[0], speaker: hit[1], lines: hit[3] };
}
