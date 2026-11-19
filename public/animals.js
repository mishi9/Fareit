// Every driver is an animal and a number (e.g. 🐷 Pig#1726): the only way drivers are told apart
// (leaderboard, owner's list). Shared by the app and the server. Animals that have an emoji.
export const ANIMAL_LIST = [
  ['Ant', '🐜'], ['Badger', '🦡'], ['Bat', '🦇'], ['Bear', '🐻'], ['Beaver', '🦫'], ['Bee', '🐝'], ['Beetle', '🪲'],
  ['Bison', '🦬'], ['Boar', '🐗'], ['Butterfly', '🦋'], ['Camel', '🐫'], ['Cat', '🐱'], ['Chicken', '🐔'], ['Chipmunk', '🐿️'],
  ['Cow', '🐮'], ['Crab', '🦀'], ['Cricket', '🦗'], ['Crocodile', '🐊'], ['Deer', '🦌'], ['Dodo', '🦤'], ['Dog', '🐶'],
  ['Dolphin', '🐬'], ['Dove', '🕊️'], ['Dragon', '🐉'], ['Duck', '🦆'], ['Eagle', '🦅'], ['Elephant', '🐘'], ['Fish', '🐟'],
  ['Flamingo', '🦩'], ['Fox', '🦊'], ['Frog', '🐸'], ['Giraffe', '🦒'], ['Goat', '🐐'], ['Goose', '🪿'], ['Gorilla', '🦍'],
  ['Hamster', '🐹'], ['Hedgehog', '🦔'], ['Hippo', '🦛'], ['Horse', '🐴'], ['Jellyfish', '🪼'], ['Kangaroo', '🦘'], ['Koala', '🐨'],
  ['Ladybug', '🐞'], ['Leopard', '🐆'], ['Lion', '🦁'], ['Lizard', '🦎'], ['Llama', '🦙'], ['Lobster', '🦞'], ['Mammoth', '🦣'],
  ['Monkey', '🐵'], ['Moose', '🫎'], ['Mouse', '🐭'], ['Octopus', '🐙'], ['Orangutan', '🦧'], ['Otter', '🦦'], ['Owl', '🦉'],
  ['Ox', '🐂'], ['Panda', '🐼'], ['Parrot', '🦜'], ['Peacock', '🦚'], ['Penguin', '🐧'], ['Pig', '🐷'], ['Poodle', '🐩'],
  ['Pufferfish', '🐡'], ['Rabbit', '🐰'], ['Raccoon', '🦝'], ['Ram', '🐏'], ['Rhino', '🦏'], ['Rooster', '🐓'], ['Scorpion', '🦂'],
  ['Seal', '🦭'], ['Shark', '🦈'], ['Sheep', '🐑'], ['Shrimp', '🦐'], ['Skunk', '🦨'], ['Sloth', '🦥'], ['Snail', '🐌'],
  ['Snake', '🐍'], ['Spider', '🕷️'], ['Squid', '🦑'], ['Swan', '🦢'], ['Tiger', '🐯'], ['Tropical fish', '🐠'], ['Turkey', '🦃'],
  ['Turtle', '🐢'], ['T-Rex', '🦖'], ['Unicorn', '🦄'], ['Water buffalo', '🐃'], ['Whale', '🐳'], ['Wolf', '🐺'], ['Worm', '🪱'],
  ['Zebra', '🦓'],
];
const BY_NAME = new Map(ANIMAL_LIST.map(([n, e]) => [n, e]));
export const isAnimal = (name) => BY_NAME.has(name);
export const animalEmoji = (name) => BY_NAME.get(name) || '🐾';
// "🐷 Pig#1726", or "🐾 #1726" before an animal is picked.
export const tagOf = (animal, num) => `${animalEmoji(animal)} ${animal || ''}#${String(num).padStart(4, '0')}`;
