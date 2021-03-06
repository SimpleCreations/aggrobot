const fs = require("fs");

module.exports = () => {

    const database = JSON.parse(fs.readFileSync("../database.json"));

    const vowelRegExp = /[аеёиоуыэюя]/g;
    const nonLastVowelRegExp = /[аеёиоуыэюя](?=[а-яё])/g;
    const sibilantRegExp = /[жчшщ]([ео])/;
    const misspellLettersRegExp = /[аеио](?=[а-яё])/;
    const result = new Set();
    const processResponse = response => {

        response = response.replace(/([а-яё]*)%g\(([^,]*),([^)]*)\)/ig,
            (...matches) => `${matches[1]}${matches[2]} ${matches[1]}${matches[3]}`);

        response.toLowerCase().split(/[^а-яё]+/).filter(String).forEach(word => {

            if (word.includes("ё")) return;

            const sibilantMatches = word.match(sibilantRegExp);
            if (!sibilantMatches || !(sibilantMatches[1] == "е" || word.match(vowelRegExp).length > 1)) {

                if (word.search(misspellLettersRegExp) == -1) return;

                const letters = word.match(nonLastVowelRegExp);
                if (!letters || letters.length < 2 || letters.length == 1 && "еюя".includes(word.charAt(0))) return;

            }

            result.add(word);

        });

    };

    Object.keys(database).forEach(key => {
        const structures = ["answers", "conditional", "name_rhymes"];
        const responses = database[key];
        if (structures.includes(key)) Object.values(responses).forEach(responses => responses.forEach(processResponse));
        else if (Array.isArray(responses)) responses.forEach(processResponse);
    });

    return result;

};
