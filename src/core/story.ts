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
      [c.p >= 100_000_000, ['A hundred million pieces. I have run out of happy tears, so now I just smile.', 'Promise me one thing: the Asakusa stand stays open. Always.']],
      [c.ch2 && c.cities > 1, ['My sushi recipe crossing oceans... my late wife would have laughed and laughed.', 'Send an old man a postcard from each city, eh?']],
      [c.ch2, [`A million pieces... ${c.name}, you have made this old man cry happy tears.`, 'But an emperor never stops. The world is hungry!']],
      [c.ev === 'festival', ['The festival! In my day I rolled sushi until sunrise and danced until lunch.', 'Keep the rice coming — today everyone is hungry.']],
      [c.ev === 'rain', ['Rain keeps the walk-ins home. Good day to sharpen knives and fix what is broken.']],
      [c.night, ['Still awake? Even sushi rice needs a rest, you know.', 'Go home. The fish will still be here in the morning. Probably.']],
      [c.allKaiten, ['Ryo has no shops left to lose. Be kind to him — he will need a friend more than a rival now.']],
      [c.bought > 0, ['You bought out a rival? Hm. Be gracious in victory. Tokyo is a small town with a long memory.']],
      [c.ginza, ['Ginza! I once delivered sushi there on a bicycle. A doorman chased me off with an umbrella.']],
      [c.n > 3, [`${c.n} restaurants! When I opened this stand I could barely afford rice.`, 'Remember: a busy kitchen still needs a kind heart.']],
      [c.p > 1000, ['The neighbors talk about your sushi now. That is how it begins.', 'Hire good people. You cannot roll every piece yourself forever.']],
      [true, ['Fresh fish, gentle hands, quick service. That is the whole secret.', 'Customers will not wait forever — watch their patience bubbles!']],
    ]);
    case 'mika': return pick([
      [c.p >= 10_000_000, ['Ten million pieces! My delivery vans have your logo AND mine now. Very fashionable.', 'I named the newest truck after you. It is the fastest one, obviously.']],
      [c.ch2, ['You used to buy fifteen salmon at a time from me. Now my whole fleet works for you!']],
      [c.ev === 'shortage_salmon', ['Salmon shortage! The boats came back half empty. Cucumber maki is looking very heroic today.']],
      [c.ev === 'shortage_tuna', ['No tuna anywhere! I tried bribing a fisherman with cake. Do not tell my mother.']],
      [c.ev === 'festival', ['Festival day! I have been gutting fish since 4 a.m. and I have never been happier. Or smellier.']],
      [c.ev === 'tourists' || c.ev === 'holiday', ['The crowds are huge! Stock up now, before your shelves look like my fridge at midnight.']],
      [c.morning, ["Morning catch just came in! Still cold, still shiny, still judging you with its little eyes."]],
      [c.night, ['Mika\'s Fresh Fish is closing up. I can sell you ice, a mop, or my sympathy.']],
      [c.n > 2, ['Big orders lately! Thinking about scheduled deliveries? Research it in your business menu.']],
      [c.districts > 1, ['New district, same fish! I will drive it over myself. My scooter loves a challenge.']],
      [true, ["Welcome to Mika's Fresh Fish! Freshest catch in Asakusa. Buy in bulk to save trips.", 'Out of stock means angry customers. Keep an eye on your inventory!']],
    ]);
    case 'sato': return pick([
      [c.ch2 && c.cities > 1, ['Multiple cities. Multiple currencies. Multiple headaches. Excellent — headaches mean growth.', 'Franchises pay while you sleep. Do sleep, occasionally.']],
      [c.ch2, ['One million pieces. Congratulations. Now we discuss franchises. Celebration is scheduled for 3 minutes.']],
      [c.allRivals, ['No rivals remain in Tokyo. Monopoly is efficient. Complacency is not. Keep quality up.']],
      [c.bought > 0, ['Acquiring rivals: expensive, but it removes a price war from the spreadsheet. Acceptable.']],
      [c.ev === 'critic', ['A critic is in town. One good review is worth a month of advertising. One bad one costs two.']],
      [c.ev === 'festival' || c.ev === 'holiday', ['Demand spike. Staff up, stock up, and do not discount. Hungry people are not price-sensitive.']],
      [c.ev === 'rain', ['Rain. Walk-ins fall, takeout rises. Automated kitchens profit. Umbrellas are not a business plan.']],
      [c.night, ['It is late. I am billing you for this conversation at the night rate.']],
      [c.districts >= 3, ['Three districts. Watch rent versus revenue per location. Romance is for Kenji.']],
      [c.n > 3, ['Several locations now. Managers will save you from running between them like a startled pigeon.']],
      [c.p > 5000, ['Revenue is healthy. Reinvest it: upgrades compound, idle cash does not.']],
      [true, ['Mr. Sato, business advisor. Spend on things that make money: chefs, seats and signs first.', 'Marketing works best when your kitchen can handle the extra guests.']],
    ]);
    case 'ryo': return pick([
      [c.allKaiten, ['Kaiten King has no kingdom left. Happy? ...Okay, maybe your tamago is better than mine.', 'If you ever need someone who knows conveyor belts, I am... available.']],
      [c.kaiten.length > 0, [`...You bought my ${c.kaiten.join(' and ')} shop. Fine.`, 'A king does not need every castle. I will beat you somewhere else!']],
      [c.ch2, ['A million pieces? Lucky streak. My belts have carried at least... several of those. Probably.']],
      [c.ev === 'festival', ['Festival day! My conveyor belts are running at maximum speed. Try to keep up, stand-boy!']],
      [c.ev === 'critic', ['Aoki is in town? She called my sushi "efficient." I am still not sure that was a compliment.']],
      [c.shibuya, ['You opened in Shibuya? That is MY turf. The neon there spells "Kaiten King" if you squint.']],
      [c.p >= 1000, ['See that red sign across the street? Mine. Enjoy watching your customers ride my belts.']],
      [c.night, ['My belts never sleep. Your little stand goes dark at night. That is the difference between us.']],
      [true, ['Ryo Tanaka, Kaiten King. Cute little stand. My conveyor belts will crush you!', 'Sushi is about volume. Volume and low prices!']],
    ]);
    case 'aoki': return pick([
      [c.ch2 && c.cities > 1, ['I hear you have gone international. I shall be visiting. Unannounced, naturally.']],
      [c.ch2, ['A million pieces. Quantity is not quality... but I admit you have managed both. Do not quote me.']],
      [c.ev === 'critic', ['I am working today. Do not look at me. Do not wave. Do not "accidentally" give me extra uni.']],
      [c.stars >= 4.5, ['Your stars are earned, not bought. That is rarer in this city than real wasabi.']],
      [c.ginza, ['Ginza. Bold. Here the diners can taste fear in the rice. Season accordingly.']],
      [c.bought > 0, ['Buying your competitors is not the same as surpassing them. Remember that.']],
      [c.ev === 'rain', ['Rain softens the city and ruins my shoes. Your miso soup had better be worth the walk.']],
      [c.night, ['Late-night sushi is a test of character. Most restaurants fail it. Do not be most restaurants.']],
      [c.p >= 2000, ['My review stands. If you want a better one, earn it — one perfect piece at a time.']],
      [true, ['Madame Aoki, food critic. I visit when you least expect it.', 'Quality above all. Disappoint me and all of Tokyo will know.']],
    ]);
  }
}

/** Returns the next unseen story beat (marking it seen in s.flags), or null. Order = priority. */
export function checkStoryBeat(s: GameState): StoryBeat | null {
  const c = context(s);
  const beats: [string, string, boolean, string[]][] = [
    ['kenji_million', 'Grandpa Kenji', c.p >= 1_000_000, [
      `${c.name}... one million pieces. Forty years at that stand and I never dreamed of a number like that.`,
      'You did not just keep my little stand alive. You made it a legend. Thank you.',
      'Now go — Tokyo is only the beginning. The whole world is hungry!']],
    ['ryo_rival', 'Ryo Tanaka', c.p >= 1000, [
      'So you are the one stealing my Asakusa customers. Ryo Tanaka, owner of Kaiten King.',
      'I just opened a shop across the street. Conveyor belts, rock-bottom prices. Good luck, stand-boy!']],
    ['mika_regular', 'Mika', c.p >= 500 && !!s.flags.boughtOnce, [
      'You are officially my best customer! Kenji only ever bought cucumbers and gossip.',
      "Here's a tip: keep a buffer of salmon. Customers adore it and shortages strike without warning."]],
    ['aoki_review', 'Madame Aoki', c.ev === 'critic' || c.p >= 2000, [
      'I have tasted your sushi. The rice is honest. The fish is fresh. The service is... improving.',
      'Three stars out of five. Most chefs never get a review at all. Do not let it go to your head.']],
    ['second_shop', 'Grandpa Kenji', c.n >= 2, [
      'A second restaurant! Ha! Now you understand why my hair turned white.']],
    ['sato_intro', 'Mr. Sato', c.p >= 5000, [
      'Mr. Sato. I advise businesses that are about to become interesting. Yours qualifies.',
      'Rule one: profit per seat. Rule two: never run out of rice. There is no rule three. Yet.']],
    ['ryo_buyout', 'Ryo Tanaka', c.kaiten.length > 0, [
      `You... bought my ${c.kaiten[0] ?? 'Asakusa'} shop? With MY sign still on it?`,
      'This is not over. A king has many castles!']],
    ['aoki_ginza', 'Madame Aoki', c.ginza, [
      'Ginza. So the street-stand chef wants to sit at the grown-ups\' table.',
      'Very well. I dine here weekly. Impress me, or leave quietly.']],
    ['ryo_truce', 'Ryo Tanaka', c.allKaiten, [
      'All my shops... gone. I built Kaiten King from one secondhand conveyor belt, you know.',
      '...Your sushi is better. There. I said it. Do not make me say it twice.']],
    ['sato_world', 'Mr. Sato', c.cities > 1, [
      'A second city. Your brand now travels faster than your fish. Watch quality across every franchise.']],
    ['mika_fleet', 'Mika', c.p >= 10_000_000, [
      'Ten million pieces! I just bought my fiftieth delivery truck. Fifty! I started with a bicycle!',
      "Mika's Fresh Fish delivers to every one of your kitchens now. Fresh, fast, and painted in your colors."]],
  ];
  const hit = beats.find(([id, , ok]) => ok && !s.flags['story_' + id]);
  if (!hit) return null;
  s.flags['story_' + hit[0]] = true;
  return { id: hit[0], speaker: hit[1], lines: hit[3] };
}
