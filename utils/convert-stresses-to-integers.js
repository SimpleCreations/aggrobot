const fs = require("fs");
const wordsNeeded = require("./extract-unique-words")();

const existingStresses = JSON.parse(fs.readFileSync("../database.json"))["stress"] || {};
const newStresses = JSON.parse(fs.readFileSync("unique-words.json"));
const WORDS_TO_KEEP = ["антон", "васютин", "понедельник", "вторник", "четверг", "пятница", "суббота", "воскресенье"];

Object.keys(existingStresses).forEach(word => {
    if (!wordsNeeded.has(word) && !WORDS_TO_KEEP.includes(word)) delete existingStresses[word];
});

Object.keys(newStresses).forEach(word => {
    if (!wordsNeeded.has(word) || existingStresses[word] !== undefined) return;
    const yoPosition = newStresses[word].indexOf("ё");
    if (yoPosition != -1) return existingStresses[word] = -yoPosition - 1;
    const stressCharacterPosition = newStresses[word].search(/[^а-я]/);
    if (stressCharacterPosition != -1) return existingStresses[word] = stressCharacterPosition;
    console.log(`Warning: word '${word}' has no stress`);
});

const resultObject = {};
Object.keys(existingStresses).sort().forEach(word => resultObject[word] = existingStresses[word]);

fs.rename("stresses.json", "stresses.old.json", () =>
    fs.writeFileSync("stresses.json", JSON.stringify(resultObject, null, 2)));