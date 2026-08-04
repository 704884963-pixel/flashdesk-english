// First-run seed: 26 AI-901 cards — the six responsible-AI principles in both
// directions, plus scenario → capability drills.

const PRINCIPLES = [
  ['Transparency', 'Understand the data, algorithms, transformations, and final model in training.'],
  ['Accountability', 'Procedures for human intervention and overriding AI decisions.'],
  ['Reliability & Safety', 'System follows original design, handles unexpected situations, resists malicious manipulation.'],
  ['Fairness', 'Prevent discrimination based on gender, race, orientation, religion.'],
  ['Inclusiveness', 'Design AI that empowers everyone, accommodates diverse abilities like accents and disabilities.'],
  ['Privacy & Security', 'Protect sensitive data; users control how their data is used.'],
];

const SCENARIOS = [
  ['Convert text between languages', 'Translation'],
  ['Identify what language text is in', 'Language detection'],
  ['Text to spoken audio', 'Speech synthesis (text-to-speech)'],
  ['Spoken audio to text', 'Speech recognition (speech-to-text)'],
  ['Positive/negative/neutral feedback', 'Sentiment analysis'],
  ['What does the user want to do', 'Azure Language intent recognition (CLU)'],
  ['Find names, orgs, dates in text', 'Entity recognition'],
  ['Extract fields from varied-layout invoices with no labeled training data', 'Content Understanding'],
  ['Train image model on my own labeled images', 'Custom Vision'],
  ['General image analysis with prebuilt models', 'Computer Vision / Azure Vision'],
  ['Clock in by face', 'Facial detection + facial recognition'],
  ['Control pronunciation, pauses, pitch in generated speech', 'SSML'],
  ['Out-of-scope chatbot utterances go to', 'the None intent'],
  ['AI that reasons, uses tools, completes multi-step tasks', 'Agentic AI'],
];

const cards = [];
for (const [name, description] of PRINCIPLES) {
  cards.push({ front: name, back: description, deck: 'AI-901' });
  cards.push({ front: description, back: name, deck: 'AI-901' });
}
for (const [scenario, capability] of SCENARIOS) {
  cards.push({ front: scenario, back: capability, deck: 'AI-901' });
}

module.exports = cards;
