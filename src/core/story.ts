// Story NPC dialogue and one-shot story beats, chosen from game progress. Pure logic.
import { DISTRICTS, DistrictId, RIVALS } from './data';
import { GameState } from './state';

export type StoryNpcId = 'kenji' | 'mika' | 'sato' | 'ryo' | 'aoki';
export interface StoryBeat { id: string; speaker: string; lines: string[] }

/** Rival shops the player has bought out: a listed district with no market share left. */
function buyouts(s: GameState): { rival: string; district: DistrictId }[] {
  return Object.values(RIVALS).flatMap((r) =>
    r.districts.filter((d) => s.rivals[r.id]?.[d] === undefined).map((d) => ({ rival: r.id, district: d })));
}

function context(s: GameState) {
  const bought = buyouts(s);
  const kaiten = bought.filter((b) => b.rival === 'kaiten').map((b) => DISTRICTS[b.district].name);
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
    ev: s.event?.id,
    night: s.minute >= 22 * 60 || s.minute < 5 * 60,
    morning: s.minute >= 5 * 60 && s.minute < 10 * 60,
    bought: bought.length,
    allRivals: bought.length === Object.values(RIVALS).reduce((a, r) => a + r.districts.length, 0),
    kaiten,
    allKaiten: kaiten.length === RIVALS.kaiten.districts.length,
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
      [c.ev === 'festival', ['I used to do the festival with one cooker and a borrowed knife.', 'Start the next batch while you still have half a pot.']],
      [c.ev === 'rain', ['You can hear the rain hit the awning when the street empties. Good time to sharpen your knives.']],
      [c.night, ['You\'re still here? I could see your light from the station.', 'Put the fish away and give your feet a rest.']],
      [c.allKaiten, ['Ryo used to come by after closing for tea. You could put the kettle on.']],
      [c.bought > 0, ['When you take over a shop, learn the regulars\' names before you change the sign.']],
      [c.ginza, ['I once rode a delivery to Ginza. A doorman sent me round the back without even looking at the box.']],
      [c.n > 3, [`${c.n} restaurants! When I opened this stand I could barely afford rice.`, 'Who will close the stand when you\'re across town?']],
      [c.p > 1000, ['The neighbor from the stationery shop asked if you\'d be open for lunch tomorrow.', 'That\'s when I\'d look for a second pair of hands.']],
      [true, ['Go easy on the rice. Squeeze it too hard and they\'ll taste it before they taste the fish.', 'If someone has been standing a while, take their order first.']],
    ]);
    case 'mika': return pick([
      [c.p >= 10_000_000, ['Ten million. I had to paint your name on another van.', 'If you see one parked outside the stand, that\'s your salmon. I\'m probably having lunch.']],
      [c.ch2, ['I used to fit your order in one ice box. Now I\'ve got two vans on your route.']],
      [c.ev === 'shortage_salmon', ['The salmon boat came in light. I can give you a better price on cucumbers today.']],
      [c.ev === 'shortage_tuna', ['Tuna\'s scarce this morning. I\'ll ring you if more comes in.']],
      [c.ev === 'festival', ['I\'ve been cutting fish since four. Tell me how much you need before the lunch crowd gets here.']],
      [c.ev === 'tourists' || c.ev === 'holiday', ['The station\'s already packed. Buy enough for the second rush while you\'re here.']],
      [c.morning, ["Morning. The salmon\'s just off the truck. I\'ve put yours on ice."]],
      [c.night, ['Mika\'s Fresh Fish is closing up. I can sell you ice, a mop, or my sympathy.']],
      [c.n > 2, ['Leave me the amounts your kitchens need. Once you\'ve arranged scheduled deliveries, I\'ll pack them every morning.']],
      [c.districts > 1, ['Which shop do you want this at? I\'ve got room on the scooter if it\'s just one box.']],
      [true, ["How much can you fit in your fridge? I\'ll wrap it in lots of ten.", 'Set a little salmon aside for dinner. The regulars always ask.']],
    ]);
    case 'sato': return pick([
      [c.ch2 && c.cities > 1, ['Each city gets its own ledger. That\'s how you\'ll see which franchises are paying their way.', 'Check the royalties once a day. You\'ll see more than you would staring at the till.']],
      [c.ch2, ['Congratulations. Bring me the figures from your busiest shop tomorrow. We can use them to price a franchise.']],
      [c.allRivals, ['No rivals remain in Tokyo. Monopoly is efficient. Complacency is not. Keep quality up.']],
      [c.bought > 0, ['Your new shop comes with regulars and a lease. Add up both before you celebrate.']],
      [c.ev === 'critic', ['A critic is in town. One good review is worth a month of advertising. One bad one costs two.']],
      [c.ev === 'festival' || c.ev === 'holiday', ['Put someone on the counter during the rush. A discount won\'t help if the queue is already out the door.']],
      [c.ev === 'rain', ['Rain will thin the queue. Watch what each shop actually sells before you order tomorrow\'s stock.']],
      [c.night, ['It is late. I am billing you for this conversation at the night rate.']],
      [c.districts >= 3, ['Compare the rent with the takings at each shop. A full room in Shibuya can make less than a quiet one in Asakusa.']],
      [c.n > 3, ['It takes time to cross town. Put a manager in the shop you can least afford to leave unattended.']],
      [c.p > 5000, ['Look at which station holds up service. That\'s where I\'d spend the next yen.']],
      [true, ['Sato. Show me where the queue backs up and I\'ll tell you where to spend.', 'If the kitchen is already behind, hold off on advertising.']],
    ]);
    case 'ryo': return pick([
      [c.allKaiten, ['I sold the last belt this morning. I kept the motor.', 'If one of yours jams, I still know how to unstick it.']],
      [c.kaiten.length > 0, [`...You bought my ${c.kaiten.join(' and ')} shop. Fine.`, 'Double-check the belt tension before your first lunch. The left gear sticks.']],
      [c.ch2, ['A million. I saw the paper. Don\'t tell anyone I bought a copy.']],
      [c.ev === 'festival', ['I oiled the belts before dawn. Let\'s see whose line moves faster at lunch.']],
      [c.ev === 'critic', ['Aoki is in town? She called my sushi "efficient." I am still not sure that was a compliment.']],
      [c.shibuya, ['I took my lunch past your place in Shibuya. Your line was longer than mine. Today.']],
      [c.p >= 1000, ['That\'s my red sign across the street. I put it where people would see it from your queue.']],
      [c.night, ['Hear that rattle? I\'ve been chasing it round the same belt all night.']],
      [true, ['Ryo Tanaka. I run the conveyor place across the street.', 'Two minutes from door to plate at lunch. Your turn.']],
    ]);
    case 'aoki': return pick([
      [c.ch2 && c.cities > 1, ['I hear you have gone international. I shall be visiting. Unannounced, naturally.']],
      [c.ch2, ['Someone told me a million. I went back to see if the rice was still as good. It was.']],
      [c.ev === 'critic', ['I\'m working today. Bring me the piece you\'d give the person at the next seat.']],
      [c.stars >= 4.5, ['I sent a friend last week. She described the same piece I had. That matters.']],
      [c.ginza, ['In Ginza I can get good fish on any block. Give me a reason to come back to yours.']],
      [c.bought > 0, ['Buying your competitors is not the same as surpassing them. Remember that.']],
      [c.ev === 'rain', ['I walked here in the rain. I was hoping to sit somewhere warm and eat an unhurried lunch.']],
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
    ['mika_regular', 'Mika', c.p >= 500 && !!s.flags.boughtOnce, [
      'I’ve started keeping a box with your name on it. Kenji used to make me split one with him.',
      'Put a little salmon aside when the delivery comes. You’ll want it at the end of the dinner rush.']],
    ['aoki_review', 'Madame Aoki', c.ev === 'critic' || c.p >= 2000, [
      'The salmon was good. The rice had cooled by the time it reached me.',
      'Three stars. Give me a reason to order a second piece next time.']],
    ['second_shop', 'Grandpa Kenji', c.n >= 2, [
      'Two sets of keys now. Mark them before you walk home with the wrong ones.']],
    ['sato_intro', 'Mr. Sato', c.p >= 5000, [
      'Sato. I’ve been looking at your lunch receipts.',
      'Work out what you’re making per seat before you start paying for more seats.']],
    ['ryo_buyout', 'Ryo Tanaka', c.kaiten.length > 0, [
      `You’ve got my ${c.kaiten[0] ?? 'Asakusa'} shop, then. Has the old sign come down yet?`,
      'There’s a drawer under the counter that sticks. Lift the handle when you pull.']],
    ['aoki_ginza', 'Madame Aoki', c.ginza, [
      'I dine in Ginza once a week. I’ll make your shop the next stop.',
      'Send out whatever you’re proudest of that day. I’ll leave the order to you.']],
    ['ryo_truce', 'Ryo Tanaka', c.allKaiten, [
      'The first Kaiten King was a secondhand belt and six stools. I didn’t think I’d miss the noise.',
      'If you’re free after close, I could use a seat at your counter.']],
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
