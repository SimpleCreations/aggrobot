// ==VPPScript==
// @name            AggroBot
// @version         0.1.0
// @script-filename aggrobot.vpp.js
// @update-url      https://raw.githubusercontent.com/SimpleCreations/aggrobot/master/update.json
// @script-url      https://raw.githubusercontent.com/SimpleCreations/aggrobot/master/aggrobot.vpp.js
// ==/VPPScript==

VPP.chats[0].log("[AggroBot] Проверка обновлений...");
$.ajax({
    url: VPPScript.meta["update-url"],
    dataType: "json",
    cache: false
})
    .pipe(response => response["script_version"] ? response : $.Deferred().reject())
    .done(response => VPP.chats[0].log(response["script_version"] > VPPScript.meta["version"] ?

        `[AggroBot] Вы используете устаревший скрипт.<br>
    Текущая версия: ${VPPScript.meta["version"]}<br>
    Последняя версия: ${response["script_version"]}<br>
    Введите "/aggrobot download", чтобы скачать последнюю версию.` :

        `[AggroBot] Вы используете последнюю версию скрипта.`

    ))
    .fail(() => VPP.chats[0].log("[AggroBot] Не удалось получить данные об обновлении."));



VPP.Chat.prototype.aggrobot = (command, ...args) => {

    switch (command) {

        case "download":

            const $a = $("<a>").attr({
                href: VPPScript.meta["script-url"],
                download: VPPScript.meta["script-filename"]
            }).appendTo("body");
            $a[0].click();
            $a.remove();

            break;

    }

};

VPPScript.stop = () => {
    delete VPP.Chat.prototype.aggrobot;
};