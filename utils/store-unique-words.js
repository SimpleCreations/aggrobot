const fs = require("fs");

const result = require("./extract-unique-words")();
const existingStresses = JSON.parse(fs.readFileSync("../database.json"))["stress"] || {};
const resultObject = {};
Array.from(result).sort().forEach(word =>
    existingStresses[word] === undefined && (resultObject[word] = word));

fs.rename("unique-words.json", "unique-words.old.json", () =>
    fs.writeFileSync("unique-words.json", JSON.stringify(resultObject, null, 2)));