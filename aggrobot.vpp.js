// ==VPPScript==
// @name            AggroBot
// @version         1.0.1
// @script-filename aggrobot.vpp.js
// @update-url      https://raw.githubusercontent.com/SimpleCreations/aggrobot/Workflow/update.json
// @script-url      https://raw.githubusercontent.com/SimpleCreations/aggrobot/master/aggrobot.vpp.js
// @database-url    https://raw.githubusercontent.com/SimpleCreations/aggrobot/Workflow/database.json
// ==/VPPScript==

const log = message => VPP.chats[0].log(`[AggroBot] ${message}`);

const compareVersions = (version1, version2) => {
    version1 = version1.split(".");
    version2 = version2.split(".");
    for (let i = 0; i < version2.length; i++) {
        if (!version1[i] || +version2[i] > +version1[i]) return 1;
        else if (+version2[i] < +version1[i]) return -1;
    }
    return version2.length != version1.length ? -1 : 0;
};

log("Проверка обновлений...");
$.ajax({
    url: VPPScript.meta["update-url"],
    dataType: "json",
    cache: false
}).pipe(response => response["script_version"] ? response : $.Deferred().reject()).done(response => {

    if (compareVersions(response["script_version"], VPPScript.meta["version"]) < 0) {
        return log(`Вы используете устаревший скрипт.<br>
Текущая версия: ${VPPScript.meta["version"]}<br>
Последняя версия: ${response["script_version"]}<br>
Введите "/aggrobot download", чтобы скачать последнюю версию.`);
    }
    log("Вы используете последнюю версию скрипта.");

    if (!response["database_version"]) return log("Не удалось получить последнюю версию базы сообщений.");
    const currentDatabaseVersion = VPPScript.storage.databaseVersion;
    if (!currentDatabaseVersion || compareVersions(response["database_version"], currentDatabaseVersion) < 0) {

        log(!currentDatabaseVersion ? "Идёт скачивание базы сообщений..." : "Идёт обновление базы сообщений...");
        $.ajax({
            url: VPPScript.meta["database-url"],
            dataType: "json",
            cache: false
        }).done(database => {
            VPPScript.storage.database = database;
            VPPScript.storage.databaseVersion = response["database_version"];
            VPPScript.storage.save();
            log("База сообщений успешно " + (!currentDatabaseVersion ? "загружена." : "обновлена."));
            enableScript();
        }).fail(() => {
            log("Не удалось скачать базу сообщений.");
            if (currentDatabaseVersion) enableScript();
        });

        VPP.chats.forEach(chat =>
            chat.addEventListener(VPP.Chat.Event.CONNECTED, "aggrobot", () =>
                chat.log("[AggroBot] Скрипт начнёт работу только по завершении загрузки базы сообщений.")));

    }
    else enableScript();

}).fail(() => log("Не удалось получить данные об обновлении."));

const enableScript = () => {

    let firstDatabase = null;
    VPP.chats.forEach(chat => {

        const aggroBot = new AggroBot();
        chat.aggroBot = aggroBot;
        const database = !firstDatabase ? (firstDatabase = AggroBot.Database.fromRaw(VPPScript.storage.database)) :
            AggroBot.Database.fromAnother(firstDatabase);
        aggroBot.setDatabase(database);
        aggroBot.onTypingStart = () => chat.isChatStarted() && chat.setStartedTyping();
        aggroBot.onTypingFinish = () => chat.isChatStarted() && chat.setFinishedTyping();
        aggroBot.onMessageReady = message => chat.isChatStarted() && chat.sendMessage(message);
        aggroBot.onConversationFinish = () => {
            aggroBot.suspend();
            chat.isChatStarted() && chat.close();
        };
        aggroBot.onReport = message => chat.log(message);

        aggroBot.onImageReady = imageURL => {
            if (!chat.isChatStarted()) return;
            const chatId = chat.chatId;
            const image = new VPP.Image(imageURL);
            image.onLoad = () => {
                image.onUpload = () => chat.chatId == chatId && chat.sendImage(image);
                image.upload();
            };
        };

        chat.removeEventListener("aggrobot");
        chat.addEventListener(VPP.Chat.Event.CONNECTED, "aggrobot", () => {

            // Генерируем новое состояние бота и готовим приветственное сообщение
            chat.messageSent = false;
            chat.aggrobotWasActive = false;
            if (AggroBot.autoStart) {
                aggroBot.reset();
                chat.aggrobotWasActive = true;
            }

            // Обращаемся к деанонимайзеру
            if (AggroBot.deanonEnabled && AggroBot.deanonURL) {

                // Если включён деанонимайзер, то ожидаем ответа от него в течение некоторого времени перед тем, как запрашивать приветствие
                const chatId = chat.chatId;
                let responseRequested = false;
                setTimeout(() =>
                    !responseRequested && (responseRequested = true) &&
                    chat.chatId == chatId && !aggroBot.messagesReceived && aggroBot.prepareResponse(), 1750);

                VPP.ajax({
                    url: AggroBot.deanonURL,
                    data: {
                        guid: chat.guidOpp
                    },
                    cache: false,
                    success: function(response) {

                        if (chat.chatId != chatId) return;

                        response = JSON.parse(response);
                        if (Array.isArray(response["log"])) response["log"].forEach(row => console.log("%c" + row, "color: #AA0000;"));

                        if (!response["gender"] && !response["name"] && !response["vk"]) chat.log("Деанонимайзер не нашёл данных об этом пользователе");
                        else aggroBot.processDeanonResult((gender => {
                            return gender == "male" ? AggroBot.UserProfile.Gender.MALE :
                                gender == "female" ? AggroBot.UserProfile.Gender.FEMALE : undefined;
                        })(response["gender"]), response["name"], response["vk"]);

                        if (!responseRequested) {
                            responseRequested = true;
                            if (!aggroBot.messagesReceived) aggroBot.prepareResponse();
                        }

                    }
                });

            }

            // Иначе просто готовим приветствие
            else if (aggroBot.active) aggroBot.prepareResponse();

        });

        chat.addEventListener(VPP.Chat.Event.MESSAGE_RECEIVED, "aggrobot", (type, content) => {

            if (!aggroBot.active) return;

            let request;
            switch (type) {
                case VPP.Chat.MessageType.TEXT:
                    request = new AggroBot.Request(AggroBot.Request.Type.TEXT);
                    request.text = content;
                    break;
                case VPP.Chat.MessageType.IMAGE:
                    request = new AggroBot.Request(AggroBot.Request.Type.PHOTO);
                    request.photoURL = content;
                    break;
                case VPP.Chat.MessageType.STICKER:
                    request = new AggroBot.Request(AggroBot.Request.Type.STICKER);
                    const groupId = +content.match(/\/stickers\/(\d+)\//i)[1];
                    switch (groupId) {
                        case 4: request.stickerGroupName = "pony"; break;
                        case 6: request.stickerGroupName = "cat"; break;
                        case 8: request.stickerGroupName = "nichosi"; break;
                        case 9: request.stickerGroupName = "seagull"; break;
                    }
                    break;
            }
            aggroBot.receiveMessage(request);
            aggroBot.prepareResponse(request, chat.messageSent);

        });

        chat.addEventListener(VPP.Chat.Event.MESSAGE_DELIVERED, "aggrobot", () => chat.messageSent = true);

        chat.addEventListener(VPP.Chat.Event.USER_STARTED_TYPING, "aggrobot", () => {

            if (!aggroBot.active) return;

            // Если собеседник начал печатать во время ответа бота, бот на короткое время "отвлекается" от набора текста
            aggroBot.waitForOpponent();

        });

        chat.addEventListener(VPP.Chat.Event.DISCONNECTED, "aggrobot", () => {

            chat.setFinishedTyping();
            if (aggroBot.active) aggroBot.suspend();

        });

    });

};

const AggroBot = class {

    /**
     * Генерирует новое состояние бота
     */
    reset() {

        this.suspend();

        if (this._database) this._database.reset();

        /**
         * Работает ли бот
         * @type {boolean}
         */
        this.active = true;

        /**
         * ID таймеров различных откладываемых действий
         * @type {number}
         * @private
         */
        this._readTimeout = null;
        this._typeTimeout = null;
        this._interruptedTimeout = null;
        this._activityCheckTimeout = null;

        /**
         * Счётчик тиков неактивности собеседника
         * @type {number}
         * @private
         */
        this._inactivityCounter = 0;

        /**
         * Timestamp, когда бот начал печать ответа.
         * Вспомогательное свойство.
         * @type {number}
         * @private
         */
        this._typingStartedTime = null;

        /**
         * Очередь ответов бота
         * @type {Array<AggroBot.QueuedResponse>}
         * @private
         */
        this._responseQueue = [];

        /**
         * Было ли отправлено приветственное сообщение
         * @type {boolean}
         * @private
         */
        this._greeted = false;

        /**
         * Установлено в true, если бот ещё не писал сообщение с момента получения последнего сообщения от собеседника
         * @type {boolean}
         * @private
         */
        this._directResponse = false;

        /**
         * Намеревается ли бот покинуть чат после опустошения очереди
         * @type {boolean}
         * @private
         */
        this._intendsToLeave = false;

        /**
         * Количество сообщений, отправленных ботом.
         * Используется для оценки актуальности тех или иных сообщений от собеседника.
         * @type {number}
         */
        this.messagesReceived = 0;

        /**
         * Информация о пользователе
         * @type {AggroBot.UserProfile}
         * @private
         */
        this._userProfile = new AggroBot.UserProfile();

        /**
         * Стиль письма бота
         * @type {AggroBot.Style}
         * @private
         */
        this._style = new AggroBot.Style();

        /**
         * Переменные, подставляемые во фразы
         * @type {object}
         * @private
         */
        this._variables = {};

        /**
         * Детектор флуда/спама
         * @type {AggroBot.SpamDetector}
         * @private
         */
        this._spamDetector = new AggroBot.SpamDetector();

        /**
         * Последний запрос, который посчитался флудом/спамом
         * @type {AggroBot.Request}
         * @private
         */
        this._spamRequest = null;

        /**
         * Флаг установлен, если бот игнорирует запросы о подготовке ответа
         * @type {boolean}
         * @private
         */
        this._ignoringPrepareRequests = false;

        /**
         * Флаг установлен, если бот уже посылал своё фото
         * @type {boolean}
         * @private
         */
        this._photoSent = false;

        /**
         * Сколько раз бот отвечал условным ответом
         * @type {number}
         * @private
         */
        this._respondedByCondition = 0;

    }

    /**
     * Устанавливает базу сообщений бота
     * @param {AggroBot.Database} database
     */
    setDatabase(database) {

        this._database = database;

    }

    /**
     * Приостанавливает работу бота
     */
    suspend() {

        this.active = false;
        clearTimeout(this._readTimeout);
        this._readTimeout = null;
        clearTimeout(this._typeTimeout);
        this._typeTimeout = null;
        clearTimeout(this._interruptedTimeout);
        this._interruptedTimeout = null;
        clearTimeout(this._activityCheckTimeout);
        this._activityCheckTimeout = null;

    }

    /**
     * Возобновляет работу бота
     */
    resume() {

        this.active = true;
        this._clearQueue();

    }

    /**
     * Уведомляет бота о том, что ему отослали сообщение
     * @param {AggroBot.Request} request Сообщение от собеседника
     */
    receiveMessage(request) {

        // Пытаемся определить пол
        if (request.type === AggroBot.Request.Type.TEXT) this._determineGenderAndName(request.text);

        // Полученное сообщение считается активностью, поэтому сбрасываем счётчик
        this._inactivityCounter = 0;
        this._intendsToLeave = false;

        this.messagesReceived++;
        this._directResponse = true;

        // Смотрим, есть ли в очереди ответы, которые должны быть удалены из очереди во время получения сообщения
        let queueUpdated = false;
        if (this._responseQueue[0] && this._responseQueue[0].discardOnMessage) {
            this._removeNextQueuedResponse();
            queueUpdated = true;
        }
        this._responseQueue = this._responseQueue.filter(queued => !queued.discardOnMessage);
        if (queueUpdated) this._setQueueUpdated();

        // Если бот получил сообщение, пока писал своё, он отвлекается на его прочтение
        const nextQueued = this._responseQueue[0];
        if (nextQueued) {
            if (nextQueued.interruptOnMessage) this._interrupt(AggroBot.getTimeToRead(request));
        }
        
        // Проверяем на спам/флуд
        const alreadyResponding = this._responseQueue.some(queued => queued.isSpamResponse);
        const {result, variables} = this._spamDetector.analyzeNext(request, alreadyResponding);
        if (result) {
            this._spamRequest = request;
            if (!alreadyResponding) {
                Object.assign(this._variables, variables);
                this._processAndAddToQueue(this._getMessage(result), {
                    readDelay: AggroBot.getTimeToRead(request),
                    isSpamResponse: true
                });
            }
        }
        else {
            this._spamRequest = null;
            this._ignoringPrepareRequests = this._spamDetector.state === AggroBot.SpamDetector.State.IGNORING;
            if (!this._ignoringPrepareRequests && this._responseQueue[0] && this._responseQueue[0].isSpamResponse) {
                while(this._responseQueue[0] && this._responseQueue[0].isSpamResponse) this._removeNextQueuedResponse();
                this._setQueueUpdated();
            }
        }

        if (!this._responseQueue[0]) this._resetInactiveTimeout();

    }

    /**
     * Готовит и откладывает ответ собеседнику
     * @param {AggroBot.Request} request Сообщение от собеседника
     * @param {boolean} withoutGreeting Нужно ли пропустить приветствие
     */
    prepareResponse(request = null, withoutGreeting = false) {

        if (this._ignoringPrepareRequests || request != null && this._spamRequest == request) return;

        // Отправляем приветствие
        if (!this._greeted) {
            this._greeted = true;
            if (!withoutGreeting) {
                this._processAndAddToQueue(this._getMessage("greetings"), {
                    discardOnMessage: true
                });
                return;
            }
        }

        // Проверяем, занят ли бот
        const ready = !this._responseQueue[0] || this._responseQueue.every(queued => !queued.blockQueue);

        const defaultOptions = {readDelay: AggroBot.getTimeToRead(request)};
        let added = false;
        let allowSecondary = true;

        // Пытаемся найти ответ по регулярному выражению или на особые типы контента
        if (request != null) switch (request.type) {

            case AggroBot.Request.Type.TEXT:

                // Ответ на запрос фото
                if (!this._photoSent &&
                        /(фот|селфи)[а-яё]* (себя |сво[еёию] )?(с?кин(ь|еш)|кида(й|еш)|го(?![а-я])|давай|сдела(й|еш)|(при|вы|ото)шл(и|еш)|отправ(ь|иш))|(кин|кида|([^а-яё]|^)го|дава|сдела|(при|вы|ото)шл|отправ)(и|й|еш|иш)?ь? (себя |сво[еёию] )?(фот|селфи)|сфот(к?а|огр[ао]фиру)й(ся| себя)/i.test(request.text) &&
                        !this._responseQueue.some(queued => queued.pattern == "photo_sending")) {
                    this._processAndAddToQueue(this._getMessage("photo_sending"), Object.assign({
                        pattern: "photo_sending"
                    }, defaultOptions));
                    const queued = new AggroBot.QueuedResponse(AggroBot.selfieURL, AggroBot.QueuedResponse.ContentType.IMAGE);
                    queued.readDelay = AggroBot.TIME_TO_MAKE_PHOTO;
                    queued.pattern = "photo_sending";
                    queued.interruptOnTyping = false;
                    queued.interruptOnMessage = false;
                    this._enqueueResponse(queued);
                    this._photoSent = true;
                    added = true;
                    allowSecondary = false;
                    break;
                }

                // Ответ на запрос ВКонтакте; установка флага, если собеседник пишет, что у него нет ВКонтакте; обработка ссылки на страницу
                if (AggroBot.vkEnabled) {
                    let matches;
                    if (/(кинь|скажи|напиши|пришли|дай|давай|([^а-яё]|^)го|отправь|черкани|сыл(ку|ь)( на)?|линк(ани)?|записан)(( ты)? свой| ты| в)? (вк|vk|id|айди|одноклас+ники|фб|fb|фейсбук|facebook|телег|в(ай|и)бер|в[оа](тс|ц)ап)|(вк[оа][а-я]+|vk|id|айди|одноклас+ники|фб|fb|фейсбук|facebook|телег(у|рам+)|в(ай|и)бер|в[оа](тс|ц)ап+)( свой)? (с?кинь|скажи|напиши|пришли|дай|давай|го|отправь|черкани|с+ыл(ку|ь)|линк)/i.test(request.text) ||
                        /(кинь|скажи|напиши|пришли|дай|давай|([^а-яё]|^)го|отправь|черкани|лучше) ([ст]во[ейю]|ты|сам|с+ыл(ку|ь))|([ст]во[ейю]|ты|сам|сыл(ку|ь)) (с?кинь|скажи|напиши|пришли|дай|давай|го|отправь|черкани|лучше|первы[йм])/i.test(request.text) && typeof this._userProfile.vkRequestedAt !== "undefined" && this.messagesReceived - this._userProfile.vkRequestedAt <= 6) {
                        this._processAndAddToQueue(this._getMessage(!this._userProfile.vkSent ? "vk_response" : "vk_already_sent"), defaultOptions);
                        added = true;
                    } else if (/(у )?меня (нет )?(в )?(вк|стра)|^нет вк/i.test(request.text) || /у меня (его )?нет|не зарег|^нету$|не сижу/i.test(request.text) && this.messagesReceived - this._userProfile.vkRequestedAt <= 6) {
                        console.log("User does not have VK profile");
                        this._userProfile.vkUserDoesNotHave = true;
                    } else if (this.messagesReceived - this._userProfile.vkRequestedAt <= 10 && (matches = request.text.match(/(?:(?:https?:\/\/)?vk\.com)?(\/?id\d+|\/[a-z][\w.]{4,})/i))) {
                        const vk = matches[1].replace("/", "");
                        if (this._userProfile.vk) {
                            if (this._userProfile.vk != vk) {
                                this._processAndAddToQueue(this._getMessage("vk_another_profile"), defaultOptions);
                                added = true;
                            }
                        } else if (vk == AggroBot.vkCustomURL || vk == AggroBot.vkIdURL) {
                            this._processAndAddToQueue(this._getMessage("vk_myself"), defaultOptions);
                            added = true;
                        } else if (vk == "id0") {
                            this._processAndAddToQueue(this._getMessage("vk_id0"), defaultOptions);
                            added = true;
                        } else {
                            this._processAndAddToQueue(this._getMessage("vk_acknowledged"), defaultOptions);
                            added = true;
                            VPP.ajax({
                                url: "https://api.vk.com/method/users.get",
                                data: {
                                    "lang": "ru",
                                    "access_token": AggroBot.vkToken,
                                    "v": "5.69",
                                    "user_ids": vk,
                                    "fields": "sex,photo_max_orig"
                                },
                                success: response => {
                                    response = JSON.parse(response);
                                    if (response["error"] && response["error"]["error_code"] == 113) VPP.ajax({
                                        url: "https://vk.com/" + vk,
                                        success: response => {
                                            if (response == "error" || $(response).is(":contains('Страница удалена либо ещё не создана')")) {
                                                this._processAndAddToQueue(this._getMessage("vk_does_not_exists"), defaultOptions);
                                            } else {
                                                this._processAndAddToQueue(this._getMessage("vk_invalid"), defaultOptions);
                                            }
                                        }
                                    });
                                    else {
                                        this._userProfile.vk = vk;
                                        const profile = response["response"][0];
                                        if (profile["sex"]) {
                                            this._userProfile.gender = profile["sex"] == 2 ? AggroBot.UserProfile.Gender.MALE : AggroBot.UserProfile.Gender.FEMALE;
                                            this.onReport("Пол ВКонтакте: " + (profile["sex"] == 2 ? "мужской" : "женский"));
                                        }
                                        const name = profile["first_name"];
                                        if (!this._userProfile.name || !(this._userProfile.nameConfirmed || this._userProfile.name == name)) {
                                            this._userProfile.name = name;
                                            this.onReport(`Имя ВКонтакте: ${name}`);
                                        }
                                        if (response["photo_max_orig"] == "https://vk.com/images/camera_400.png") {
                                            this._processAndAddToQueue(this._getMessage("vk_no_avatar"), defaultOptions);
                                            console.log("Profile does not have an avatar");
                                        } else VPP.ajax({
                                            url: "https://www.google.com/searchbyimage?hl=ru&image_url=" + response["photo_max_orig"],
                                            headers: {
                                                "Accept-Language": "ru;q=1"
                                            },
                                            success: response => {
                                                const description = $(response).find(":contains('Скорее всего, на картинке')").last().find("a").text();
                                                console.log(`Google's image guess: ${description}`);
                                                if (description) VPP.ajax({
                                                    url: "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=" + encodeURIComponent(description),
                                                    success: response => {

                                                        const translated = JSON.parse(response)[0][0][0].toLowerCase();
                                                        console.log(`Translated Google's image guess: ${translated}`);
                                                        if (/^(дженте?льмен|кожаный пиджак|девушка|шапочка|мотоциклетный шлем|дружба|сидящий|стоящий|толстовка с капюшоном|селфи|пользователь|свадебное платье|деловой человек|человек|мужчина|парень|личность|свитер|военная форма)$/.test(translated)) {

                                                            this._processAndAddToQueue(this._getMessage("vk_avatar_person"), defaultOptions);
                                                            console.log(`Assuming a person`);

                                                        } else {

                                                            let gender = 0;
                                                            if (/[ая]$/.test(translated)) gender = 1;
                                                            else if (/[ое]$/.test(translated)) gender = 2;
                                                            this._variables["vkavatarobjectgender"] = (...args) => args[gender];

                                                            const accusative = translated.replace(/[ая]я?(?![а-яё])/g, match => {
                                                                return match.replace(/а/g, "у").replace(/я/g, "ю");
                                                            });
                                                            this._variables["vkavatarobject"] = wordsCase => wordsCase == "accusative" ? accusative : translated;

                                                            this._processAndAddToQueue(this._getMessage("vk_avatar_object"), defaultOptions);
                                                            console.log(`Assuming an object`);

                                                        }

                                                    }
                                                });
                                            }
                                        });
                                    }
                                }
                            });
                        }
                    }
                }


                // Ответы на реакцию на запрос подтверждения имени
                if (typeof this._userProfile.nameConfirmationRequestedAt !== "undefined" && this.messagesReceived - this._userProfile.nameConfirmationRequestedAt <= 6) {
                    if (this._userProfile.name && /(как|откуда)( ты)?( меня)? (узнал|знаеш|угадал)|^как\??$|меня помниш/i.test(request.text)) {
                        this._processAndAddToQueue(this._getMessage("name_source"), defaultOptions);
                        this._userProfile.nameConfirmed = true;
                        added = true;
                        console.log("Name confirmed");
                        break;
                    } else if (/^(а+|э+м+)?[^а-я]*да+([^а-яё]|$)|[^н]. угадал|^(угадал|почти|ага)|(^конечно|именно|верно|почти|допустим|прикинь|возможно|^а ч(то|[её])|^(ну )?и( что| ч[её])?)[^а-я]*$|^(\+|ну)$/i.test(request.text)) {
                        this._userProfile.nameConfirmed = true;
                        console.log("Name confirmed");
                        break;
                    } else if (/^не([та\-]| верно| угадал|$)|^(мен)?я не |^мимо[^а-я]*$|^-$/i.test(request.text) && !this._userProfile.nameConfirmed) {
                        this._processAndAddToQueue(this._getMessage("name_incorrect"), defaultOptions);
                        this._userProfile.name = undefined;
                        this._userProfile.nameConfirmed = false;
                        this._userProfile.nameAskedAt = this.messagesReceived;
                        added = true;
                        console.log("Name rejected");
                        break;
                    }
                }

                // Ответы по регулярному выражению
                const {message, pattern} = this._getAnswer(request.text);
                if (message != null) this._processAndAddToQueue(message, Object.assign({
                    pattern: pattern
                }, defaultOptions)) && (added = true);

                break;

            case AggroBot.Request.Type.PHOTO:

                if (!this._responseQueue.some(queued => queued.pattern == "photo")) this._processAndAddToQueue(this._getMessage("photo"), Object.assign({
                    pattern: "photo"
                }, defaultOptions)) && (added = true);
                break;

            case AggroBot.Request.Type.STICKER:

                const databaseKey = `sticker_${request.stickerGroupName}`;
                if (this._database.has(databaseKey) && !this._responseQueue.some(queued => queued.pattern == "sticker")) {
                    const message = this._getMessage(databaseKey);
                    if (message) this._processAndAddToQueue(message, Object.assign({
                        pattern: "sticker"
                    }, defaultOptions)) && (added = true);
                }
                break;

        }

        // Добавляем в очередь уточнение имени собеседника, а также рифму к имени
        if (!added && ready && this._userProfile.name && !this._userProfile.nameConfirmed &&
                Math.random() < AggroBot.getNameConfirmationProbability(this._userProfile.nameConfirmationRequests)) {
            console.log("Reporting name...");
            this._userProfile.nameConfirmationRequests++;
            this._processAndAddToQueue(this._getMessage("name_confirmation"), defaultOptions);
            this._userProfile.nameConfirmationRequestedAt = this._userProfile.nameAskedAt = this.messagesReceived;
            added = true;
        }
        if (!added && ready && this._userProfile.nameConfirmed && !this._userProfile.nameRhymed &&
                Math.random() < AggroBot.PROBABILITY_NAME_RHYME) {
            const rhyme = AggroBot.nameVariations.split(",").indexOf(this._userProfile.name) == -1 ?
                this._getNameRhyme() : this._getMessage("name_same");
            if (rhyme) {
                console.log("Got a rhyme to the name...");
                this._processAndAddToQueue(rhyme, defaultOptions);
                added = true;
                allowSecondary = false;
            }
            else console.log("No rhymes to this name");
            this._userProfile.nameRhymed = true;
        }

        // Добавляем в очереди запрос ВКонтакте
        if (AggroBot.vkEnabled && AggroBot.vkToken && !added && ready && !this._userProfile.vk && !this._userProfile.vkUserDoesNotHave &&
                Math.random() < AggroBot.getVKRequestProbability(this._userProfile.vkRequests)) {
            this._userProfile.vkRequests++;
            this._processAndAddToQueue(this._getMessage("vk_request"), defaultOptions);
            this._userProfile.vkRequestedAt = this.messagesReceived;
            added = true;
        }

        // Добавялем в очередь условный ответ
        if (!added && ready && Math.random() < AggroBot.getConditionalResponseProbability(this._respondedByCondition)) {
            console.log("picking conditional response...");
            const possibleSets = Object.keys(AggroBot.satisfiesCondition).filter(key =>
                this._database.conditional.has(key) && AggroBot.satisfiesCondition[key]()).map(key =>
                this._database.conditional.get(key));
            let response = null;
            while (!response && possibleSets.length) {
                const index = Math.floor(Math.random() * possibleSets.length);
                response = possibleSets[index].getRandom();
                if (!response) possibleSets.splice(index, 1);
            }
            if (response) {
                const message = this._processMessage(response.string);
                if (message) {
                    this._processAndAddToQueue(message, defaultOptions);
                    this._respondedByCondition++;
                    added = true;
                }
            }
        }

        // Добавляем в очередь новый первичный ответ, если бот не занят
        if (!added && ready) {
            this._processAndAddToQueue(this._getMessage("primary"), defaultOptions);
            added = true;
        }

        // Добавляем вторичные ответы
        if (added && allowSecondary) while (Math.random() < AggroBot.PROBABILITY_SECONDARY) {
            this._processAndAddToQueue(this._getMessage("secondary"), {
                readDelay: AggroBot.TIME_ADDITIONAL_READ_DELAY,
                interruptOnTyping: false,
                discardOnMessage: true
            });
        }

    }

    /**
     * Задерживает ответ
     */
    waitForOpponent() {

        if (this._responseQueue[0]) {
            if (this._responseQueue[0].interruptOnTyping) this._interrupt(AggroBot.TIME_WAIT);
        }
        else this._resetInactiveTimeout();

    }

    /**
     * Вызывается, когда нужно начать посылать уведомление о наборе сообщения
     */
    onTypingStart() {}

    /**
     * Вызывается, когда нужно закончить посылать уведомление о наборе сообщения
     */
    onTypingFinish() {}

    /**
     * Вызывается, когда нужно отправить ответ от бота
     */
    onMessageReady() {}

    /**
     * Вызывается, когда нужно отправить изображение от бота
     */
    onImageReady() {}

    /**
     * Вызывается, когда бот инициирует завершение чата
     */
    onConversationFinish() {}

    /**
     * Вызывается, когда бот посылает отчётную информацию
     */
    onReport() {}

    /**
     * Форсирует проверку очереди сообщений
     * @private
     */
    _setQueueUpdated() {

        // Ничего не делаем, если бот уже читает запрос или пишет ответ
        if (this._readTimeout || this._typeTimeout || this._interruptedTimeout) return;

        // Если очередь не пустая, запускаем таймер чтения последнего сообщения.
        // Иначе запускаем таймер неактивности собеседника.
        const queued = this._responseQueue[0];
        if (queued) this._readTimeout = setTimeout(this._setReadingFinished.bind(this), queued.readDelay);
        else if (this._intendsToLeave) setTimeout(this.onConversationFinish.bind(this), 100);
        else this._resetInactiveTimeout();

    }

    /**
     * Вспомогательный метод, вызываемый, когда чтение (задержка перед набором) текущего сообщения должно быть закончено
     * @private
     */
    _setReadingFinished() {

        this._readTimeout = null;
        this._typingStartedTime = Date.now();
        const typeDelay = this._responseQueue[0].typeDelay;
        if (typeDelay) this.onTypingStart();
        this._typeTimeout = setTimeout(this._setTypingFinished.bind(this), typeDelay);

    }

    /**
     * Вспомогательный метод, вызываемый, когда набор текущего сообщения должен быть закончен
     * @private
     */
    _setTypingFinished() {

        this._typeTimeout = null;
        this.onTypingFinish();

        const queued = this._responseQueue.shift();
        switch (queued.contentType) {
            case AggroBot.QueuedResponse.ContentType.TEXT:
                this.onMessageReady(queued.message);
                this._spamDetector.storeOutput(queued.message);
                break;
            case AggroBot.QueuedResponse.ContentType.IMAGE:
                this.onImageReady(queued.imageURL);
                break;
        }
        this._directResponse = false;
        this._setQueueUpdated();

    }

    /**
     * Запускает таймер, который, если во время его активности собеседник не был активен, увеличивает счётчик тиков
     * неактивности по его истечении.
     * При каждом прибавлении бот выполняет действия, направленные на привлечение внимания собеседника.
     * Если собеседник неактивен несколько тиков подряд, соединение разрывается.
     * @private
     */
    _resetInactiveTimeout() {

        clearTimeout(this._activityCheckTimeout);
        if (!this._intendsToLeave) this._activityCheckTimeout = setTimeout(() => {
            this._activityCheckTimeout = null;
            if (this._ignoringPrepareRequests) return this._resetInactiveTimeout();
            switch (++this._inactivityCounter) {
                case 1:
                    this.prepareResponse();
                    break;
                case 2:
                case 3:
                    this._processAndAddToQueue(this._getMessage("inactivity_response"), {
                        discardOnMessage: true
                    });
                    break;
                case 4:
                    this._intendsToLeave = true;
                    this._processAndAddToQueue(this._getMessage("before_leaving"), {
                        discardOnMessage: true
                    });
                    break;
            }
        }, AggroBot.TIME_INCREMENT_INACTIVE_COUNTER);

    }

    /**
     * Добавляет ответ в очередь
     * @param {AggroBot.QueuedResponse} queued
     * @private
     */
    _enqueueResponse(queued) {

        this._responseQueue.push(queued);
        this._setQueueUpdated();

    }

    /**
     * Отменяет подготовку к отправке следующего ответа в очереди
     * @private
     */
    _removeNextQueuedResponse() {

        this._responseQueue.shift();
        clearTimeout(this._readTimeout);
        clearTimeout(this._typeTimeout);
        clearTimeout(this._interruptedTimeout);
        this._readTimeout = null;
        this._typeTimeout = null;
        this._interruptedTimeout = null;
        this._resetInactiveTimeout();

    }

    /**
     * Очищает очередь
     * @private
     */
    _clearQueue() {

        clearTimeout(this._readTimeout);
        this._readTimeout = null;
        clearTimeout(this._typeTimeout);
        this._typeTimeout = null;
        clearTimeout(this._interruptedTimeout);
        this._interruptedTimeout = null;

        this._responseQueue.length = 0;
        this._setQueueUpdated();

    }

    /**
     * Задерживает/прерывает/отвлекает бота от чтения/печати на время
     * @param {number} time Время, мс
     * @private
     */
    _interrupt(time) {

        if (!this._readTimeout && !this._typeTimeout) return;

        // Если в данный момент активно чтение, то чтение будет закончено по истечение переданного времени
        if (this._readTimeout) {
            clearTimeout(this._readTimeout);
            this._readTimeout = setTimeout(this._setReadingFinished.bind(this), time);
        }

        // Если же активна печать, то статус печати перестаёт отправляться на переданное время
        else if (this._typeTimeout) {
            clearTimeout(this._typeTimeout);
            this._typeTimeout = null;
            this.onTypingFinish();
            const delayLeft = this._responseQueue[0].typeDelay - (Date.now() - this._typingStartedTime);
            this._interruptedTimeout = setTimeout(() => {
                this._interruptedTimeout = null;
                this._responseQueue[0].typeDelay = delayLeft;
                this.onTypingStart();
                this._typeTimeout = setTimeout(this._setTypingFinished.bind(this), delayLeft);
            }, time);
        }

    }

    /**
     * Возвращает случайное необработанное сообщение из базы сообщений по ключу
     * @param {string} databaseKey
     * @returns {string}
     * @private
     */
    _getRawMessage(databaseKey) {

        const response = this._database.getRandom(databaseKey);
        return response && response.string;

    }

    /**
     * Обрабатывает функции и флаги внутри строки
     * @param {string} message
     * @param {Array<string>} matches Массив совпадений для %m
     * @returns {string | null}
     * @private
     */
    _processMessage(message, matches = []) {

        if (message == null) return null;

        let invalid = false;
        message = message.replace(/%(\w+)(?:\(([^,)]*(?:,[^,)]*)*)\))?/g, (_, name, args) => {

            args = args ? args.split(",") : [];

            switch (name) {
                case "g":
                case "gender":
                    if (!args.length) {
                        const genderName = this._userProfile.gender === AggroBot.UserProfile.Gender.MALE ?
                            ["мужик", "пацан", "парень"] : ["баба", "телка", "девушка"];
                        return genderName[Math.floor(Math.random() * genderName.length)];
                    }
                    return (this._userProfile.gender === AggroBot.UserProfile.Gender.MALE ? args[0] : args[1]) || "";
                case "userprofilename":
                    return this._userProfile.name || "";
                case "d":
                case "direct":
                    if (!this._directResponse) invalid = true;
                    break;
                case "nd":
                case "nondirect":
                    if (this._directResponse) invalid = true;
                    break;
                case "firstname":
                    return AggroBot.firstName.toLowerCase();
                case "lastname":
                    return AggroBot.lastName.toLowerCase();
                case "shortname":
                    return AggroBot.shortName.toLowerCase();
                case "vk":
                    return "https://vk.com/" + (AggroBot.vkUseIdURL ? AggroBot.vkIdURL : AggroBot.vkCustomURL);
                case "m":
                case "match":
                    return (matches[+(args[0] || 0)] || "").toLowerCase();
                case "ifm":
                case "ifmatch":
                    invalid = !matches[+args[0]];
                    break;
                case "ifnm":
                case "ifnomatch":
                    invalid = !!matches[+args[0]];
                    break;
                case "timeschedule": {
                    const to12HourFormat = hours => hours % 12 || 12;
                    const toFullHourFormat = hours => {
                        const hours12 = to12HourFormat(hours);
                        return hours12 == 1 ? "час" : `${hours12} час${hours12 < 5 ? "а" : "ов"}`;
                    };
                    const now = new Date();
                    const minutes = now.getMinutes();
                    const hours = now.getHours();
                    if (minutes <= 15) return toFullHourFormat(hours);
                    if (minutes < 45) return `${minutes <= 25 ? "почти" : ""} пол ${to12HourFormat(hours + 1)}`;
                    return "почти " + toFullHourFormat(hours + 1);
                }
                case "timehour": {
                    const now = new Date();
                    return (now.getHours() + (now.getMinutes() > 25)) % 12 || 12;
                }
                case "timeofday": {
                    const now = new Date();
                    const hours = now.getHours() + now.getMinutes() / 100;
                    if (hours < 5.30 || hours > 23.30) return "посреди ночи";
                    if (hours < 12) return "с утра";
                    if (hours < 18) return "посреди дня";
                    return "весь вечер";
                }
                case "timedayofweek":
                    return ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"][new Date().getDay()];
                case "asksname":
                    this._userProfile.nameAskedAt = this.messagesReceived;
                    break;
                default:
                    if (typeof this._variables[name] === "string") return this._variables[name];
                    else if (typeof this._variables[name] === "function") return this._variables[name].apply(this, args);
            }

            return "";

        }).replace(/[$@]\w+/g, "");
        return !invalid ? message : null;

    }

    /**
     * Возвращает случайное сообщение из базы сообщений по ключу
     * @param {string} databaseKey
     * @returns {string}
     * @private
     */
    _getMessage(databaseKey) {

        let message = null;
        while (this._database.hasAvailable(databaseKey) && !message) message = this._processMessage(this._getRawMessage(databaseKey));
        return message;

    }

    /**
     * По возможности возвращает ответ на сообщение по регулярному выражению
     * @param {string} request
     * @returns {{message: string | null, pattern: RegExp | null}}
     * @private
     */
    _getAnswer(request) {

        const {response, matches, pattern} = this._database.match(request);
        let message = null;

        // Отменяем ответ по регулярному выражению, если ответ на это же самое выражение уже есть в очереди
        if (response != null && !this._responseQueue.some(queued => queued.pattern === pattern)) {
            message = this._processMessage(response.string, matches);
            if (message == null) return this._getAnswer(request);
        }

        return {message, pattern};

    }

    /**
     * Обрабатывает сообщение из базы сообщений и добавляет все полученные ответы в очередь
     * @param {string} message
     * @param {object} queuedResponseOptions Дополнительные параметры и флаги для ответа в очереди
     * @private
     */
    _processAndAddToQueue(message, queuedResponseOptions = {}) {

        this._prepareQueuedResponses(message, queuedResponseOptions).forEach(queued => this._enqueueResponse(queued));

    }

    /**
     * Обрабатывает сообщение из базы сообщений и возвращает все ответы, которые необходимо добавить в очередь
     * @param {string} message
     * @param {object} queuedResponseOptions Дополнительные параметры и флаги для ответа в очереди
     * @returns {Array<AggroBot.QueuedResponse>}
     * @private
     */
    _prepareQueuedResponses(message, queuedResponseOptions = {}) {

        // Добавляем в конец фразы слово из набора addition
        if (!/\?$/.test(message) && Math.random() < this._style.additionProbability) {
            message += (Math.random() < this._style.additionLineBreakProbability ? " // " : " ") +
                this._getMessage("addition");
        }

        // Обрабатываем разбиения
        const splitResult = [];
        message.split(" // ").forEach(part => {
            const push = response => {
                const queued = new AggroBot.QueuedResponse(response);
                Object.keys(queuedResponseOptions).forEach(key => queued[key] = queuedResponseOptions[key]);
                splitResult.push(queued);
            };
            let buffer;
            part.split(" / ").forEach(part => {
                if (!buffer) buffer = part;
                else if (Math.random() < AggroBot.getSplitProbabilityByCurrentPart(buffer)) {
                    push(buffer);
                    buffer = part;
                }
                else buffer += " " + part;
            });
            // noinspection JSUnusedAssignment
            push(buffer.trim());
        });
        
        // Вставляем слова из специальных наборов
        splitResult.forEach(queued => {
            const wordRegExp = AggroBot.Style.wordRegExp;
            wordRegExp.lastIndex = 0;
            let changed = false;
            let lastWord = "";
            queued.message = queued.message.replace(wordRegExp, (match, p1) => {
                let replacement = match;
                if (Math.random() < this._style.insideInsertionProbability) {
                    const word = this._getMessage("insert_inside");
                    if (p1 != word && lastWord != word && AggroBot.Style.PREPOSITIONS_OR_CONJUNCTIONS.indexOf(lastWord) == -1) {
                        replacement = `${word} ${match}`;
                        changed = true;
                    }
                }
                lastWord = p1;
                return replacement;
            });
            if (Math.random() < this._style.afterInsertionProbability) {
                queued.message = queued.message.replace(/[^а-яё\d]*$/, ` ${this._getMessage("insert_after")}$&`);
                changed = true;
            }
            if (changed) queued.calculateTypeDelay();
        });

        // Добавляем ошибки
        splitResult.forEach(queued => queued.message = this._style.misspell(queued.message));

        // Умножаем количество вопросительных и восклицательных знаков
        for (let i = splitResult.length - 1; i >= 0; i--) {
            const queued = splitResult[i];
            if (!/[!?]$/.test(queued.message)) continue;
            while (Math.random() < this._style.questionMarkDuplicationProbability) {
                queued.message += queued.message.slice(-1);
            }
            queued.message = queued.message.replace(/[!?]+$/, match => {
                if (Math.random() > this._style.questionMarkLineBreakProbability) return match;
                const marksQueued = new AggroBot.QueuedResponse(match);
                marksQueued.readDelay = AggroBot.TIME_ADDITIONAL_READ_DELAY;
                marksQueued.interruptOnTyping = false;
                marksQueued.interruptOnMessage = false;
                marksQueued.discardOnMessage = !!queuedResponseOptions.discardOnMessage;
                marksQueued.blockQueue = false;
                splitResult.splice(i + 1, 0, marksQueued);
                return "";
            });
        }

        // Вставляем опечатки
        let typosResult = [];
        splitResult.forEach(queued => {
            const {result, corrections} = this._style.insertTypos(queued.message);
            queued.message = result;
            typosResult.push(queued);
            corrections.forEach(correction => {
                const queued = new AggroBot.QueuedResponse(correction + "*");
                queued.readDelay = AggroBot.TIME_ADDITIONAL_READ_DELAY;
                queued.interruptOnTyping = false;
                queued.interruptOnMessage = false;
                queued.discardOnMessage = !!queuedResponseOptions.discardOnMessage;
                queued.blockQueue = false;
                typosResult.push(queued);
            });
            if (corrections.length && Math.random() < AggroBot.getTypoExclamationProbabilityByAmountOfCorrections(corrections.length)) {
                console.log("Adding exclamation");
                this._prepareQueuedResponses(this._getMessage("exclamation"), {
                    readDelay: AggroBot.TIME_ADDITIONAL_READ_DELAY,
                    discardOnMessage: !!queuedResponseOptions.discardOnMessage,
                    interruptOnTyping: false,
                    interruptOnMessage: false,
                    blockQueue: false
                }).forEach(queued => typosResult.push(queued));
            }
        });

        // Добавляем заглавные буквы
        if (this._style.capitalize) typosResult.forEach(queued =>
            queued.message.indexOf("http") != 0 &&
                (queued.message = queued.message.charAt(0).toUpperCase() + queued.message.substring(1)));

        return typosResult;

    }

    /**
     * Пытается определить имя и пол по сообщению и записать в профиль
     * @param message
     * @private
     */
    _determineGenderAndName(message) {

        // Когда нашли имя:
        // Если было написано "меня зовут", то сохраняем его без дополнительных проверок.
        // Если просто написано имя, то смотрим, спрашивал ли его бот недавно.
        const onNameMatched = matches => {
            if (matches[1] && !matches[2] || this.messagesReceived - (this._userProfile.nameAskedAt || 0) <= 6) {
                this._userProfile.name = matches[3].charAt(0).toUpperCase() + matches[3].substring(1).toLowerCase();
                this._userProfile.nameConfirmed = true;
            }
        };

        let gender, matches;
        if (matches = message.match(/((?:я|меня(?: зовут)?) |^(нет,? )?)(А[лр]и[нс]а|Агата|Аделина|Адель|Аида|Ал[её]на|Алевтина|Александра|Алла|Альбина|Аля|Анастасия|Анжел+а|Анжели[кн]а|Анна|Анфиса|Аня|Ася|Белла|Валентина|Валерия|Валя|Варвара|Варя|Вика|Виктория|Вилена|Виолет+а|Виталина|Галина|Галя|Дарина|Дарья|Даша|Диа?на|Ева|Евгения|Евдокия|Екатерина|Елена|Елизавета|Жанна|Злата|Зоя|Зина|Зинаида|Инга|Инесса|Инна|Ира|Ирина|Ирочка|Карина|Каролина|Катюша|Катя|Кира|Кристина|Ксения|Ксюша|Лара|Лариса|Ленк?а|Лера|Лида|Лидия|Лиза|Лилия|Лиля|Лина|Лия|Люба|Люда|Людмила|Людочка|Маргарита|Марго|Марина|Мария?|Марьяна|Маша|Мил[еа]на|Мила|Надежда|Надя|Наст[её]на|Настю[хш]а|Настя|Ната|Наталья|Наташа|Ника|Николь|Нина|Оксана|Олеся|Ольга|Оля|Полина|Поля|Раиса|Регина|Рената|Рита|Роза|Розалия|Руфина|Саша [дж]|Светк?а|Светлана|Снежана|Соня|Софа|Софья|Т[ао]мара|Таисия|Танюша|Таня|Татьяна|Тая|Тома|Ульяна|Уля|Фаина|Фатима|Эвелина|Эл+ина|Элеонора|Эл[иь]за|Эль[вм]ира|Эля|Эмилия|Эмма|Эрика|Юли?я|Юлька|Яна|Ярослава)(?:[^а-яё?]|$)/i)) {
            gender = AggroBot.UserProfile.Gender.FEMALE;
            onNameMatched(matches);
        } else if (matches = message.match(/((?:я|меня(?: зовут)?) |^(нет,? )?)(Адам|Аким|Александр|Алексей|Анатолий|Андрей|Андрю[хш]а|Антон|Аркадий|Аркаша|Арсен|Арсений|Арт[её]м|Арт[её]мий|Артур|Афанасий|Богдан|Борис|Боря|Вади[мк]|Валентин|Валерий|Ваня|Василий|Вася|Вениамин|Веня|Виктор|Витали[йк]|Витя|Влад|Владимир|Владислав|Владлен|Вовк?а|Всеволод|Всеслав|Вячеслав|Ген+адий|Гена|Георгий|Герман|Глеб|Григорий|Гриша|Давид|Даниил|Данила?|Даня|Демьян|Денис|Дима|Дмитрий|Евгений|Егор|Женя|Жора|Жорик|Захар|Иван|Игнат|Игнатий|Игорь|Ил+арион|Илья|Илю[хш]а|Инн+окентий|Иосиф|Кеша|Кирилл|Колян?|Константин|Костик|Костя|Л[её]ня|Л[её]ха|Л[её]ша|Лев|Леонид|Макар|Макс|Максим|Марат|Марк|Матвей|Мирослав|Миха|Михаил|Миша|Никита|Николай|Олег|П[её]тр|Павел|Паша|Петя|Платон|Р[еи]нат|Радислав|Роберт|Родион|Рома|Роман|Ростислав|Руслан|С[её]ма|Сав+а|Савелий|Саша|Святослав|Сем[её]н|Сеня|Сер[её][гж]а|Серафим|Сергей|Славк?а|Ст[её]па|Станислав|Стас|Степан|Тима|Тимофей|Тимур|Толик|Толя|Тоха|Ф[её]дор|Федя|Феликс|Филипп|Филя|Эдик|Эдуард|Эмиль|Эрик|Эрнест|Юлий|Юра|Юрий|Яков|Ян|Ярослав|Назар|Гоша|Славик|[ЭИ]льдар)(?:[^а-яё?]|$)/i)) {
            gender = AggroBot.UserProfile.Gender.MALE;
            onNameMatched(matches);
        } else if (/((^[^а-яё]*я? ?|([^а-я]|^)я (([а-мо-яё]|н(?!е))+[ \-])*)([жд](?=$| ?[.,])|дев(оч|ч[ео]н|уш)ка|женщина|женского|баба|телка|тянк?а?|дама)|(^|[^а-яё])я (бы )?[а-яё]{3,}(ая|[кл]а))($|[^а-яё?][^?.]*\.|[^а-яё?](?![^?]*\?))|я (ведь )?не (м|парень?|пацан|мальчик|муж(ик|чина)?|чувак)($|[^а-яё])|у меня нет (хуя|члена|яиц)/i.test(message) && !/^почему/i.test(message)) {
            gender = AggroBot.UserProfile.Gender.FEMALE;
        } else if (/((^[^а-яё]*я? ?|([^а-я]|^)я (([а-мо-яё]|н(?!е))+[ \-])*)(м|парень?|пацан|мальчик|муж(ик|чина|ского)?)|(^|[^а-яё])я (бы )?[а-яё]{2,}(ый|л))($|[^а-яё?][^?.]*\.|[^а-яё?](?![^?]*\?))|я (ведь )?не ([жд]|дев(оч|ч[ео]н|уш)ка|женщина|баба|телка|тянк?а?|дама)($|[^а-яё])/i.test(message) && !/^почему/i.test(message)) {
            gender = AggroBot.UserProfile.Gender.MALE;
        }

        if (gender !== undefined) {
            this.onReport("Определён пол: " + (gender === AggroBot.UserProfile.Gender.MALE ? "мужской" : "женский"));
            if (this._userProfile.gender != gender) {
                this._userProfile.gender = gender;
                if (this._responseQueue.length) this._clearQueue();
            }
        }

    }

    /**
     *
     * @param {number} [gender] Пол
     * @param {string} [name] Имя
     * @param {string} [vk] Ссылка на профиль ВКонтакте
     */
    processDeanonResult(gender, name, vk) {

        if (typeof gender !== "undefined") {
            this.onReport(`Деанонимайзер: пол: ${gender === AggroBot.UserProfile.Gender.MALE ? "мужской" : "женский"}`);
            this._userProfile.gender = gender;
        }

        if (typeof name !== "undefined") {
            name = name.charAt(0).toUpperCase() + name.substring(1);
            this.onReport(`Деанонимайзер: имя: ${name}`);
            this._userProfile.name = name;
        }

    }

    /**
     * Подбирает рифму к имени из профиля собеседника
     * @returns {string}
     * @private
     */
    _getNameRhyme() {

        for (let matcher of this._database.nameRhymes) {
            const {response} = matcher.match(this._userProfile.name);
            if (response) return response.string;
        }

    }

};

Object.assign(AggroBot, {

    /**
     * Возвращает время, необходимое для чтения запроса, мс
     * @param {AggroBot.Request} request
     * @returns {number}
     */
    getTimeToRead(request) {
        if (request == null) return 0;
        switch (request.type) {
            case AggroBot.Request.Type.TEXT:
                return 850 + 350 * (request.text + " ").match(/\s/g).length;
            case AggroBot.Request.Type.PHOTO:
                return 3500;
            case AggroBot.Request.Type.STICKER:
                return 2200;
        }
    },

    /**
     * Возвращает время, необходимое для печати сообщения, мс
     * @param {string} message
     * @returns {number}
     */
    getTimeToType(message) {
        return 500 + 210 * message.length;
    },

    /**
     * Время, в течение которого бот делает фотографию
     */
    TIME_TO_MAKE_PHOTO: 10000,

    /**
     * Время, на которое бот прерывается, когда замечает, что собеседник печатает, мс
     */
    TIME_WAIT: 4000,

    /**
     * Время, в течение которого бот ждёт пользователя, прежде чем реагировать на его неактивность, мс
     */
    TIME_INCREMENT_INACTIVE_COUNTER: 15000,

    /**
     * Время задержки перед началом печати дополнительного сообщения (части разбиения, вторичной фразы и т.д.)
     */
    TIME_ADDITIONAL_READ_DELAY: 600,

    /**
     * Вероятность написания первичного ответа
     */
    PROBABILITY_SECONDARY: 0.275,

    /**
     * Определяет вероятность вставки междометия после поправки опечатки в зависимости от количества поправок
     * @param {number} amountOfCorrections
     * @returns {number}
     */
    getTypoExclamationProbabilityByAmountOfCorrections(amountOfCorrections) {
        return Math.pow(0.3, 1 / amountOfCorrections);
    },

    /**
     * Возвращает вероятность разбиения сообщения при переданной текущей неразбитой части
     * @param message
     * @returns {number}
     */
    getSplitProbabilityByCurrentPart(message) {
        return 2 / (1 + Math.exp(-0.09 * message.length)) - 1;
    },

    /**
     * Возвращает вероятность вставки условного ответа в зависимости от количества уже отправленных таких ответов
     * @param amountOfResponses
     * @returns {number}
     */
    getConditionalResponseProbability(amountOfResponses) {
        return 1 / (50 * (amountOfResponses + 1));
    },

    /**
     * Функции, проверящие, удовлетворены ли определённые условия отправки условных фраз
     */
    satisfiesCondition: {

        "time_late": () => {
            const hour = new Date().getHours();
            return hour <= 5 || hour >= 23;
        },

        "time_before_school": () => {
            const now = new Date();
            const month = now.getMonth(), day = now.getDate(), dayOfWeek = now.getDay();
            if (month == 5 || month == 6 || month == 4 && day >= 20 || month == 7 && day <= 20 ||
                    month == 11 && day >= 20 || month == 0 && day < 7 || dayOfWeek == 6) return false;
            const hour = now.getHours();
            return dayOfWeek != 5 && hour >= 19 || dayOfWeek != 0 && hour <= 8;
        },

        "time_school_day": (dayOffset = 0) => {
            const now = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
            const month = now.getMonth(), day = now.getDate(), dayOfWeek = now.getDay();
            return !(month == 5 || month == 6 || month == 7 || month == 4 && day >= 20 ||
                    month == 11 && day >= 20 || month == 0 && day < 7 || dayOfWeek == 0 || dayOfWeek == 6);
        },

        "time_after_school": () => {
            const hour = new Date().getHours();
            return AggroBot.satisfiesCondition["time_school_day"]() && hour >= 15 && hour <= 18;
        },

        "time_during_school_hours": () => {
            const hour = new Date().getHours();
            return AggroBot.satisfiesCondition["time_school_day"]() && hour >= 9 && hour < 15;
        },

        "time_school_tomorrow": () => {
            return AggroBot.satisfiesCondition["time_school_day"](1);
        }

    },

    /**
     * Включать ли бота в начале диалога
     */
    autoStart: VPPScript.storage.get("autoStart") || true,

    /**
     * Внутреннее имя бота
     */
    firstName: "Антон",

    /**
     * ... фамилия бота
     */
    lastName: "Васютин",

    /**
     * ... короткое имя бота
     */
    shortName: "Тоха",

    /**
     * Все варианты имени бота
     */
    nameVariations: "Антон,Антоша,Антошка,Антоха,Тоха",

    /**
     * Ссылка на фото, которое бот будет отправлять в чат
     */
    selfieURL: "https://s9.postimg.cc/ioeejq9rj/image.jpg",

    /**
     * Включена ли возможность приёма, отправки и обработки профилей ВКонтакте
     */
    vkEnabled: VPPScript.storage.get("vkEnabled") || true,

    /**
     * Токен API ВКонтакте
     */
    vkToken: VPPScript.storage.get("vkToken") || undefined,

    /**
     * Короткая ссылка на профиль ВКонтакте бота
     */
    vkCustomURL: "4etkiy_poz",// toxa4etkiy

    /**
     * Ссылка на профиль ВКонтакте бота с ID
     */
    vkIdURL: "id471643183",

    /**
     * Будет ли бот присылать собеседникам ссылку с ID вместо короткой
     */
    vkUseIdURL: true,

    /**
     * Будет ли использоваться деанонимайзер для определения пола, имени и профиля ВКонтакте собеседника
     * по его идентификатору ЧатВдвоем
     */
    deanonEnabled: VPPScript.storage.get("deanonEnabled") || false,

    /**
     * Ссылка на деанонимайзер
     */
    deanonURL: VPPScript.storage.get("deanonURL") || undefined,

    /**
     * Получает вероятность того, что бот уточнит у собеседника его имя
     * @param {number} amountOfRequests Количество запросов
     */
    getNameConfirmationProbability(amountOfRequests) {
        return 1 / (10 * (amountOfRequests + 1));
    },

    /**
     * Вероятность того, что бот придумает рифму к имени собеседника
     */
    PROBABILITY_NAME_RHYME: 1,

    /**
     * Получает вероятность того, что бот попросит ВКонтакте у собеседника
     * @param {number} amountOfRequests Количество запросов
     */
    getVKRequestProbability(amountOfRequests) {
        return 1 / (12.5 * (amountOfRequests / 2 + 1));
    }

});

/**
 * Представляет запрос боту
 * @class
 */
AggroBot.Request = class {

    /**
     * @constructor
     * @param {number} type Тип контента запроса
     */
    constructor(type) {

        /**
         * Тип контента запроса
         * @type {number}
         */
        this.type = type;

        switch (type) {
            case AggroBot.Request.Type.TEXT:
                this.text = "";
                break;
            case AggroBot.Request.Type.PHOTO:
                this.photoURL = null;
                break;
            case AggroBot.Request.Type.STICKER:
                this.stickerGroupName = null;
                break;
        }

    }

};

/**
 * Тип контента запроса
 * @enum
 * @readonly
 */
AggroBot.Request.Type = Object.freeze({
    TEXT: 0,
    PHOTO: 1,
    STICKER: 2
});

/**
 * Представляет отложенный в очередь ответ бота
 * @class
 */
AggroBot.QueuedResponse = class {

    /**
     * @constructor
     * @param {string} content Содержимое ответа
     * @param {number} contentType Тип содержимого
     */
    constructor(content, contentType = AggroBot.QueuedResponse.ContentType.TEXT) {

        /**
         * Тип содержимого
         * @type {number}
         */
        this.contentType = contentType;

        switch (contentType) {

            case AggroBot.QueuedResponse.ContentType.TEXT:

                /**
                 * Сообщение
                 * @type {string}
                 */
                this.message = content;

                break;

            case AggroBot.QueuedResponse.ContentType.IMAGE:

                /**
                 * Ссылка на изображение
                 * @type {string}
                 */
                this.imageURL = content;

                break;

        }

        /**
         * Время, необходимое для чтения запроса
         * @type {number}
         */
        this.readDelay = 0;

        /**
         * Флаг: будет ли чтение или набор прервано новым сообщением от собеседника
         * @type {boolean}
         */
        this.interruptOnMessage = true;

        /**
         * Флаг: будет ли чтение или набор прервано статусом печати от собеседника
         * @type {boolean}
         */
        this.interruptOnTyping = true;

        /**
         * Флаг: будет ли отправка данного ответа отменена при получении сообщения от собеседника
         * @type {boolean}
         */
        this.discardOnMessage = false;

        /**
         * Флаг: будет ли данный ответ мешать добавлению в очередь нового первичного ответа
         * @type {boolean}
         */
        this.blockQueue = true;

        /**
         * Шаблон, по которому найден ответ
         * @type {*}
         */
        this.pattern = null;

        /**
         * Флаг: является ли ответ ответом на флуд/спам
         * @type {boolean}
         */
        this.isSpamResponse = false;

        /**
         * Время, необходимое для печати ответа
         * @type {number}
         */
        this.typeDelay = 0;

        this.calculateTypeDelay();

    }

    /**
     * Считает время, необходимое для печати ответа
     */
    calculateTypeDelay() {

        switch (this.contentType) {
            case AggroBot.QueuedResponse.ContentType.TEXT:
                this.typeDelay = AggroBot.getTimeToType(this.message);
                break;
            case AggroBot.QueuedResponse.ContentType.IMAGE:
                this.typeDelay = 0;
                break;
        }

    }

};

/**
 * Тип содержимого ответа в очереди
 * @enum
 * @readonly
 */
AggroBot.QueuedResponse.ContentType = Object.freeze({
    TEXT: 0,
    IMAGE: 1
});

/**
 * База сообщений бота
 * @class
 */
AggroBot.Database = class {

    constructor() {

        /**
         * @type {Array<AggroBot.Matcher>}
         */
        this.answers = [];

        /**
         * @type {Map<string, AggroBot.ResponseSet>}
         */
        this.conditional = new Map();

        /**
         * @type {Array<AggroBot.Matcher>}
         */
        this.nameRhymes = [];

    }

    /**
     * Генерирует новое состояние базы сообщений
     */
    reset() {

        // noinspection JSCheckFunctionSignatures
        Object.keys(this).forEach(key => this.has(key) && this[key].hardReset());

        this.answers.forEach(matcher => matcher.responses.hardReset());
        this.conditional.forEach(set => set.hardReset());

    }

    /**
     * Определяет, есть ли в базе сообщений множество ответов с данным ключом
     * @param {string} key
     * @returns {boolean}
     */
    has(key) {

        return this[key] instanceof AggroBot.ResponseSet;

    }

    /**
     * Определяет, если ли в множестве ответов с данным ключом доступные ответы
     * @param {string} key
     * @returns {boolean}
     */
    hasAvailable(key) {

        return !!this[key].totalAvailable;

    }

    /**
     * Возвращает случайный ответ по ключу
     * @param key
     * @returns {AggroBot.Response}
     */
    getRandom(key) {

        return this[key].getRandom();

    }

    /**
     * Возвращает случайный ответ по регулярному выражению с массивом совпадений в запоминающих скобках
     * @param {string} message
     * @returns {{matches: Array<string> | null, response: AggroBot.Response | null, pattern: RegExp | null}} случайный ответ и массив совпадений
     */
    match(message) {

        for (let matcher of this.answers) {
            const {response, matches, pattern} = matcher.match(message);
            if (response) return {response, matches, pattern};
        }

        return {
            response: null,
            matches: null,
            pattern: null
        };

    }

};

Object.assign(AggroBot.Database, {

    /**
     * Создает базу сообщений на основе сырого объекта с сообщениями
     * @param {Object} raw
     * @returns {AggroBot.Database}
     */
    fromRaw(raw) {

        const database = new AggroBot.Database();
        Object.keys(raw).filter(key => Array.isArray(raw[key])).forEach(key => {
            const set = new AggroBot.ResponseSet();
            const isSticker = key.indexOf("sticker_") == 0;
            raw[key].forEach(string => {
                const response = new AggroBot.Response(new String(string));
                if (isSticker) response.unique = true;
                set.add(response);
            });
            database[key] = set;
        });

        if (typeof raw.answers === "object") Object.keys(raw.answers).forEach(regExpStr => {
            const set = new AggroBot.ResponseSet();
            raw.answers[regExpStr].forEach(string => {
                const response = new AggroBot.Response(new String(string));
                response.unique = true;
                set.add(response);
            });
            let regExp;
            try {
                regExp = new RegExp(regExpStr, "i");
            }
            catch (error) {
                console.log("Invalid regular expression in answers: ", regExpStr);
                return;
            }
            database.answers.push(new AggroBot.Matcher(regExp, set));
        });

        if (typeof raw.conditional === "object") Object.keys(raw.conditional).forEach(key => {
            const set = new AggroBot.ResponseSet();
            raw.conditional[key].forEach(string => {
                const response = new AggroBot.Response(new String(string));
                response.unique = true;
                set.add(response);
            });
            database.conditional.set(key, set);
        });

        if (typeof raw.name_rhymes === "object") Object.keys(raw.name_rhymes).forEach(names => {
            const set = new AggroBot.ResponseSet();
            raw.name_rhymes[names].forEach(string => set.add(new AggroBot.Response(new String(string))));
            database.nameRhymes.push(new AggroBot.Matcher(new RegExp("^(?:" + names.replace(/,/g, "|") + ")$"), set));
        });

        return database;

    },

    /**
     * Создает базу сообщений на основе другой базы сообщений
     * @param {AggroBot.Database} anotherDatabase
     * @returns {AggroBot.Database}
     */
    fromAnother(anotherDatabase) {

        const database = new AggroBot.Database();

        // noinspection JSCheckFunctionSignatures
        Object.keys(anotherDatabase).filter(key => anotherDatabase.has(key)).forEach(key =>
            database[key] = anotherDatabase[key].clone());

        anotherDatabase.answers.forEach(matcher =>
            database.answers.push(new AggroBot.Matcher(matcher.regExp, matcher.responses.clone())));

        anotherDatabase.conditional.forEach((set, key) =>
            database.conditional.set(key, set.clone()));

        anotherDatabase.nameRhymes.forEach(matcher =>
            database.nameRhymes.push(new AggroBot.Matcher(matcher.regExp, matcher.responses.clone())));

        return database;

    }

});

/**
 * Множество ответов бота
 * @class
 */
AggroBot.ResponseSet = class {

    /**
     * @constructor
     */
    constructor() {

        this._array = [];
        this.totalAvailable = 0;

    }

    /**
     * Добавляет ответ
     * @param response
     */
    add(response) {

        this._array.push(response);
        this.totalAvailable++;

    }

    /**
     * Итерирует множество
     * @param func
     */
    forEach(func) {

        this._array.forEach(func);

    }

    /**
     * Сбрасывает флаг использованности ответов, если они не уникальные
     */
    reset() {

        this.totalAvailable = 0;
        this.forEach(response => !response.unique && ++this.totalAvailable && (response.used = false));

    }

    /**
     * Генерирует новое состояние ответов
     */
    hardReset() {

        this.totalAvailable = this._array.length;
        this.forEach(response => response.used = false);

    }

    /**
     * Возвращает случайный ответ из множества
     * @returns {AggroBot.Response}
     */
    getRandom() {

        if (!this.totalAvailable) return null;

        const index = Math.floor(Math.random() * this.totalAvailable);
        let counter = 0;
        for (let response of this._array) if (!response.used) {
            if (index == counter) {
                response.used = true;
                if (!--this.totalAvailable) this.reset();
                return response;
            }
            counter++;
        }

    }

    /**
     * Копирует множество ответов, не сохраняя только состояние использованности
     * @returns {AggroBot.ResponseSet}
     */
    clone() {

        const set = new AggroBot.ResponseSet();
        this.forEach(response => {
            const newResponse = new AggroBot.Response(response.string);
            if (response.unique) newResponse.unique = true;
            set.add(newResponse);
        });
        return set;

    }

};

/**
 * Ответ бота
 * @class
 */
AggroBot.Response = class {

    /**
     * @constructor
     * @param {String} string Текст ответа
     */
    constructor(string) {

        /**
         * Текст ответа
         * @type {String}
         */
        this.string = string;

        /**
         * Использован ли ответ
         * @type {boolean}
         */
        this.used = false;

        /**
         * Уникальный ли ответ
         * @type {boolean}
         */
        this.unique = false;

    }

};

AggroBot.Matcher = class {

    /**
     * @constructor
     * @param {RegExp} regExp
     * @param {AggroBot.ResponseSet} responses
     */
    constructor(regExp, responses) {

        this.regExp = regExp;
        this.responses = responses;

    }

    /**
     * Выполняет поиск в строке по регулярному выражению
     * @param {string} string
     * @returns {{matches: null | Array<string>, response: AggroBot.Response | null, pattern: RegExp | null}} случайный ответ и массив совпадений
     */
    match(string) {

        const pattern = this.regExp;
        const matches = string.match(pattern);
        let response = null;
        if (matches) response = this.responses.getRandom();
        return {response, matches, pattern};

    }

};

/**
 * Информация о пользователе, с которым общается бот
 * @class
 */
AggroBot.UserProfile = class {

    constructor() {

        /**
         * Гендер
         * @type {number}
         */
        this.gender = AggroBot.UserProfile.Gender.MALE;

        /**
         * Имя
         * @type {string}
         */
        this.name = undefined;

        /**
         * Каким по порядку сообщением бот уточнил имя у собеседника
         * @type {number}
         */
        this.nameConfirmationRequestedAt = undefined;

        /**
         * Количество уточнений имени у собеседника
         * @type {number}
         */
        this.nameConfirmationRequests = 0;

        /**
         * Подтвердил ли собеседник имя
         * @type {boolean}
         */
        this.nameConfirmed = false;

        /**
         * Отвечал ли бот рифмой к имени
         * @type {boolean}
         */
        this.nameRhymed = false;

        /**
         * Каким по порядку сообщением бот спросил имя у собеседника
         * @type {number}
         */
        this.nameAskedAt = undefined;

        /**
         * Каким по порядку сообщением бот спросил ВКонтакте у собеседника
         * @type {number}
         */
        this.vkRequestedAt = undefined;

        /**
         * Количество запросов ВКонтакте от бота
         * @type {number}
         */
        this.vkRequests = 0;

        /**
         * Отправил ли бот ссылку на свой профиль ВКонтакте
         * @type {boolean}
         */
        this.vkSent = false;

        /**
         * Ссылка на ВКонтакте собседника
         * @type {undefined}
         */
        this.vk = undefined;

        /**
         * true, если у собеседника нет ВКонтакте
         * @type {boolean}
         */
        this.vkUserDoesNotHave = false;

    }

};

/**
 * Гендеры
 * @enum
 * @readonly
 */
AggroBot.UserProfile.Gender = Object.freeze({
    MALE: 0,
    FEMALE: 1
});

/**
 * Стиль письма
 * @class
 */
AggroBot.Style = class {

    /**
     * Генерирует новый стиль
     * @constructor
     */
    constructor() {

        /**
         * Вероятность совершения опечатки в букве,
         * а также вероятности совершения разных видов опечаток,
         * соответственно перестановки букв, ввод не той буквы и добавление/удаление буквы.
         * @type {number}
         */
        this.typoProbability = Math.pow(2, 17 * Math.random() - 20.1) + 0.001;
        //this.typoProbability = Math.max(0.00025, 13 * Math.pow(Math.random() - 0.485, 7) + 0.001);
        console.log(`Typo probability: ${this.typoProbability.toFixed(6)}`);
        this.swapTypoProbability = Math.random() * 2 / 3;
        this.mishitTypoProbability = Math.random() * (1 - this.swapTypoProbability);
        this.alterTypoProbability = 1 - this.swapTypoProbability - this.mishitTypoProbability;

        /**
         * Вероятность исправления опечатки в последующем сообщении
         * @type {number}
         */
        this.typoCorrectionProbabilityMultiplier = Math.pow(Math.random(), 1 / 4);

        /**
         * Будут ли фразы начинаться с заглавной буквы
         * @type {boolean}
         */
        this.capitalize = Math.random() < AggroBot.Style._PROBABILITY_CAPITALIZE;

        /**
         * Вероятности допуска ошибок разных типов
         * @type {Object}
         */
        this.misspellProbability = {

            // Ошибка типа 0: замена а <-> о, и <-> е
            // От 0 до 0.4
            0: Math.pow(2, 9 * Math.random() - 11.4),

            // Ошибка типа 1: -тся/-ться
            1: AggroBot.Style._getTwoOptionProbability(0.15, 0.5),

            // Ошибка типа 2: -ишь, -ешь
            2: AggroBot.Style._getTwoOptionProbability(0.75, 0.375),

            // Ошибка типа 3: мягкий знак после шипящих
            3: AggroBot.Style._getTwoOptionProbability(0.07, 0.6),

            // Ошибка типа 4: жи, ши, ча, ща, чу, щу
            4: AggroBot.Style._getTwoOptionProbability(0.07143, 0.7),

            // Ошибка типа 5: -чк-, -чн-
            5: AggroBot.Style._getTwoOptionProbability(0.2, 0.55),

            // Ошибка типа 6: не- слитно/раздельно
            6: AggroBot.Style._getTwoOptionProbability(0.1, 0.5),

            // Ошибка типа 7: нн <-> н
            7: AggroBot.Style._getTwoOptionProbability(0.1, 0.5),

            // Ошибка типа 8: ого -> ова
            8: AggroBot.Style._getTwoOptionProbability(0.06, 0.8),

            // Ошибка типа 9: шо <-> ше, чо <-> чё, що <-> ще
            9: Math.random() * 0.8,

            // Стиль типа 10: меня -> мя, тебя -> тя
            10: AggroBot.Style._getTwoOptionProbability(0.05, 0.5),

            // Стиль типа 11: вообще -> ваще
            11: AggroBot.Style._getTwoOptionProbability(0.05, 0.5),

            // Двойные согласные
            12: AggroBot.Style._getTwoOptionProbability(0.175, 0.5),

            // тся/ться -> ца
            13: AggroBot.Style._getTwoOptionProbability(0.025, 0.85),

        };

        /**
         * Вероятность того, что восклицательный или вопросительный знак в конце фразы будет в очередной раз повторён
         * @type {number}
         */
        this.questionMarkDuplicationProbability = Math.pow(Math.max((Math.random() - 0.4) / 0.6, 0), 4.5);

        /**
         * Вероятность переноса восклицательного или вопросительного знака в следующее сообщение
         * @type {number}
         */
        this.questionMarkLineBreakProbability = Math.max(2.5 * (Math.random() - 0.6), 0);

        /**
         * Вероятность вставки в конец фразы слова из набора addition
         * @type {number}
         */
        this.additionProbability = Math.pow(Math.max((Math.random() - 0.45) / 0.6, 0), 3.7);

        /**
         * Вероятность написания этого слова в отдельном сообщении
         * @type {number}
         */
        this.additionLineBreakProbability = Math.max(2.5 * (Math.random() - 0.6), 0);

        /**
         * Вероятность вставки в любое место фразы слова из набора insert_inside
         * @type {number}
         */
        this.insideInsertionProbability = Math.pow(2, 8 * Math.random() - 9.7);

        /**
         * Вероятность вставки в конец фразы слова из набора insert_after
         * @type {number}
         */
        this.afterInsertionProbability = Math.pow(2, 7 * Math.random() - 8);

    }

    /**
     * Вставляет во фразу опечатки на основе стиля и также возвращает откорректированные слова
     * @param {string} string
     * @returns {{result: string, corrections: Array<string>}}
     */
    insertTypos(string) {

        const match = string.match(/^[^а-яё\d]+/i);
        let result = match ? match[0] : "";
        const corrections = [];

        const regExp = AggroBot.Style.wordRegExp;
        regExp.lastIndex = 0;
        let lastCorrected = false;
        let matches;
        while (matches = regExp.exec(string)) {
            const part = matches[0];
            if (part.length <= 3) {
                result += part;
                lastCorrected = false;
                continue;
            }
            let newPart = "";
            let typos = 0;
            for (let i = 0; i < part.length; i++) {
                if (Math.random() < this.typoProbability) {
                    // console.log(`making a typo in "${part}" @ ${i}`);
                    typos++;
                    let random = Math.random();
                    if (random < this.swapTypoProbability && i != part.length - 1) newPart += part[i + 1] + part[i++];
                    else if ((random -= this.swapTypoProbability) < this.mishitTypoProbability) {
                        const options = AggroBot.Style._KEYBOARD_TYPOS[part[i]];
                        newPart += options ? options[Math.floor(Math.random() * options.length)] : part[i];
                    }
                    else if ((random -= this.mishitTypoProbability) < this.alterTypoProbability) {
                        if (Math.random() < 0.5) {
                            const options = AggroBot.Style._KEYBOARD_TYPOS[part[i]];
                            newPart += part[i] + (options ? options[Math.floor(Math.random() * options.length)] : "");
                            i++;
                        }
                    }
                    else typos--;
                }
                else newPart += part[i];
            }
            result += newPart;
            if (newPart == part) typos = 0;
            if (typos) {
                if (lastCorrected) corrections[corrections.length - 1] += " " + matches[1];
                else if (Math.random() < AggroBot.Style._getTypeCorrectionProbability(typos) *
                    Math.pow(this.typoCorrectionProbabilityMultiplier, corrections.length + 1)) {
                    // console.log("Adding correction, prob: " + AggroBot.Style._getTypeCorrectionProbability(typos) *
                    //     Math.pow(this.typoCorrectionProbabilityMultiplier, corrections.length + 1));
                    corrections.push(matches[1]);
                    lastCorrected = true;
                }
                else lastCorrected = false;
            }
            else lastCorrected = false;
        }

        return {result, corrections};

    }

    /**
     * Вставляет во фразу ошибки на основе стиля
     * @param {string} string
     * @returns {string}
     */
    misspell(string) {

        // Тип 0
        {
            const wordRegExp = AggroBot.Style.wordRegExp;
            wordRegExp.lastIndex = 0;
            const letterRegExp = /[аеёиоуыэюя](?=[а-яё])/g;
            const match = string.match(/^[^а-яё\d]+/i);
            let result = match ? match[0] : "";
            let matches;
            while (matches = wordRegExp.exec(string)) {
                const part = matches[0];
                const letters = part.match(letterRegExp);
                if (!letters || letters.length < 2) { // Пропускаем короткие слова
                    result += part;
                    continue;
                }
                result += part.replace(letterRegExp, (letter, offset) => {
                    if ("аоеи".indexOf(letter) == -1 || Math.random() > this.misspellProbability[0]) return letter;
                    // console.log(`misspelling "${part}" with type 0 @ ${offset}`);
                    switch (letter) {
                        case "а": return "о";
                        case "о": return "а";
                        case "е": return "и";
                        case "и": return "е";
                    }
                });
            }
            string = result;
        }

        // Тип 1–11
        [
            /т(ь?)ся(?![а-яё])/g,
            /([еёи])шь(?![а-яё])/g,
            /([аоуыэюя][жчшщ])(ь?)(?![а-яё])/g,
            /[жш]и|[чщ][ау]/g,
            /ч([кн])/g,
            /([^а-яё]|^)н([еи])( ?)(?=[а-яё]{3,})/g,
            /([а-яё]+[аеёиоуыюя])(н+)(?=(?:[ыиао]й|[аоя]я|[аоеи](?:е|го|му)|ик|ица)(?:[^а-яё]|$))/g,
            /([а-яё]{3,}[аоеи])го(?![а-яё])/g,
            /([жчшщ])([еёо])(?=[а-чщ-яё])/g,
            /([^а-яё]|^)([мт])(ен|еб)я(?![а-яё])/g,
            /в([ао]{1,2})бще/g,
            /([бвгджзклмпрстфхцчшщ])\1/g,
            /ть?ся(?![а-яё])/g
        ].forEach((regExp, index) => {
            const type = index + 1;
            string = string.replace(regExp, (...matches) => {
                if (Math.random() > this.misspellProbability[type]) return matches[0];
                // console.log(`misspelling "${string}" with type ${type} @ ${matches[matches.length - 2]}`);
                switch (type) {
                    case 1:
                        return "т" + (matches[1] ? "" : "ь") + "ся";
                    case 2:
                        return matches[1] + "ш";
                    case 3:
                        return matches[1];
                    case 4:
                        const letter = matches[0].charAt(1);
                        return matches[0].charAt(0) + (letter == "и" ? "ы" : letter == "а" ? "я" : "ю");
                    case 5:
                        return "чь" + matches[1];
                    case 6:
                        return matches[1] + "н" + matches[2] + (matches[3] ? "" : " ");
                    case 7:
                        return matches[1] + (matches[2].length == 1 ? "нн" : "н");
                    case 8:
                        return matches[1] + "ва";
                    case 9:
                        return matches[1] + (matches[2] == "е" || matches[2] == "ё" ? "о" : "е");
                    case 10:
                        return matches[1] + matches[2] + "я";
                    case 11:
                        return "ваще";
                    case 12:
                        return matches[1];
                    case 13:
                        return "ца";
                }
            });
        });

        return string;

    }

};

// noinspection NonAsciiCharacters
Object.assign(AggroBot.Style, {

    /**
     * Регулярное выражение для поиска слов
     */
    wordRegExp: /([а-яё\d]+)([^а-яё\d]+|$)/ig,

    /**
     * Возможные подмены букв с целью симуляции опечатки
     * @private
     */
    _KEYBOARD_TYPOS: {
        "й": "цф1", "ц": "фыу", "у": "цывк", "к": "увае", "е": "капн", "н": "епрг", "г": "нрош", "ш": "голщ",
        "з": "щджх", "х": "зжэъ", "ъ": "хэ", "ф": "йцыя", "ы": "цфячв", "в": "уычса", "а": "квсмпе",
        "п": "еамир", "р": "нпито", "о": "гртьл", "л": "шоьбд", "д": "щлбюж", "ж": "здюэ", "э": "хжъ",
        "я": "фыч", "ч": "яывс", "с": "чвам ", "м": "пас и", "и": "пм тр", "т": "ори ь", "ь": "от бл", "б": "ьлдю",
        "ю": "бдж"
    },

    /**
     * Возвращает вероятность коррекции опечаток в слове на основе количества опечаток
     * @param {number} amountOfTypos
     * @returns {number}
     * @private
     */
    _getTypeCorrectionProbability(amountOfTypos) {
        switch (amountOfTypos) {
            case 0: return 0;
            case 1: return 0.3;
            case 2: return 0.775;
            case 3: return 0.925;
            default: return 1;
        }
    },

    /**
     * Вероятность установки заглавной буквы во всех вразах
     * @private
     */
    _PROBABILITY_CAPITALIZE: 2 / 3,

    /**
     * Получает очень малую или очень большую вероятность, являющуюся результатом
     * кусочно-линейной функции с наклоном slope и точкой разрыва balance
     * @param {number} slope
     * @param {number} balance
     * @returns {number}
     * @private
     */
    _getTwoOptionProbability(slope, balance) {
        const random = Math.random();
        return slope * random + (random <= balance ? 0 : 1 - slope);
    },

    /**
     * Предлоги или союзы, после которых не может быть вставлено слово
     */
    PREPOSITIONS_OR_CONJUNCTIONS: [
        "без", "в", "вне", "во", "вроде", "возле", "внутрь", "внутри", "вокруг", "для", "до", "за", "из",
        "к", "кроме", "ко", "между", "мимо", "на", "над", "надо", "о", "об", "обо", "около", "от", "ото",
        "перед", "передо", "по", "под", "подо", "после", "при", "про", "против", "ради", "с", "со", "среди", "сзади",
        "снизу", "у", "а", "даже", "если", "и", "или", "как", "когда", "но", "пока", "пусть", "тоже", "не", "ни"
    ]

});

/**
 * Представляет детектор флуда в последовательности сообщений
 * @class
 */
AggroBot.SpamDetector = class {

    /**
     * @constructor
     */
    constructor() {

        /**
         * Состояние детектора
         * @type {number}
         */
        this.state = AggroBot.SpamDetector.State.ANALYZING;

        /**
         * Буфер входящих сообщений
         * @type {Array<AggroBot.Request>}
         * @private
         */
        this._buffer = [];

        /**
         * Буфер исходящих текстовых сообщений
         * @type {Array<string>}
         * @private
         */
        this._outputBuffer = [];

        /**
         * Сообщение, повторяющееся при соответствующей категории флуда
         * @type {string}
         * @private
         */
        this._repeatedText = null;
        
    }

    /**
     * Анализирует очередное входящее сообщение
     * @param {AggroBot.Request} request
     * @param {boolean} noStateChange
     * @returns {{result: string | null, variables: object}}
     */
    analyzeNext(request, noStateChange = false) {
        
        let result = null;
        let variables = {};

        this._buffer.push(request);
        if (this._buffer.length > AggroBot.SpamDetector.BUFFER_SIZE) this._buffer.shift();

        if (this._buffer.length >= AggroBot.SpamDetector.MESSAGES_TO_CHECK_SIMPLE) (() => {

            if (this.state === AggroBot.SpamDetector.State.IGNORING) {

                // Проверяем на фразу о прекращении флуда
                if (request.type === AggroBot.Request.Type.TEXT && /надоело|заебала?с|больше не буду/i.test(request.text)) return;

                // Если две последние фразы — не флуд, прекращаем игнорировать
                const slice = this._buffer.slice(-2);
                const [last1, last2] = slice;
                if (last1.type === AggroBot.Request.Type.TEXT && last2.type === AggroBot.Request.Type.TEXT &&
                    last1.text != last2.text &&
                    (!this._repeatedText || !slice.map(request => AggroBot.SpamDetector.cleanString(request.text))
                        .some(str => str == this._repeatedText)) &&
                    !slice.some(request => this._outputBuffer.some(output => AggroBot.SpamDetector.stringsSimilar(request.text, output))) &&
                    slice.every(request => AggroBot.SpamDetector.COMMON_MESSAGE_REG_EXP.test(request.text))) return;

                result = "spam_ignoring";
                return;

            }

            let slice = this._buffer.slice(-AggroBot.SpamDetector.MESSAGES_TO_CHECK_SIMPLE);
            if (slice.every(request => request.type === AggroBot.Request.Type.TEXT)) {

                slice = slice.map(request => request.text);
                const joined = slice.join("").toLowerCase();

                // Проверяем на одинаковые символы
                let first = slice[0].toLowerCase();
                if (/^(.)\1*$/.test(first) && joined.split("").every(ch => ch == first.charAt(0))) {
                    first = first.charAt(0);
                    const characterName = AggroBot.SpamDetector.CHARACTER_NAMES[first];
                    if (characterName) {
                        result = "spam_character";
                        variables["character"] = first;
                        variables["charactername"] = variation => characterName[variation] || characterName["singular"];
                        return;
                    }
                    else if (/[а-яёa-z]/.test(first)) {
                        result = "spam_same_letter";
                        variables["letter"] = first;
                        return;
                    }
                }

                // Проверяем на разные символы
                if (/^[^а-яё0-9a-z]+$/.test(joined)) return result = "spam_single_symbol";

                // Проверяем на цифры
                if (/^[0-9]+$/.test(joined)) {
                    result = "spam_single_letter_or_digit";
                    variables["letterordigit"] = (letter, digit) => digit;
                    variables["gletterordigit"] = function(letterMale, digitMale, letterFemale, digitFemale) {
                        return this._userProfile.gender === AggroBot.UserProfile.Gender.MALE ? digitMale : digitFemale;
                    };
                    return;
                }

                // Проверяем на одиночные буквы
                if (slice.every(str => /^[а-яёa-z]$/i.test(str))) {
                    result = "spam_single_letter_or_digit";
                    variables["letterordigit"] = letter => letter;
                    variables["gletterordigit"] = function(letterMale, letterFemale) {
                        return this._userProfile.gender === AggroBot.UserProfile.Gender.MALE ? letterMale : letterFemale;
                    };
                    return;
                }

                // Проверяем на повторы
                const clean = slice.map(AggroBot.SpamDetector.cleanString);
                first = clean[0];
                if (first && clean.every(str => str == first)) {
                    this._repeatedText = first;
                    return result = "spam_repetition";
                }

                // Проверяем на копирование за ботом
                if (clean.some(str => str.length > 6) && clean.every(str => this._outputBuffer.some(output =>
                        AggroBot.SpamDetector.stringsSimilar(str, output)))) {
                    return result = "spam_copying";
                }

            }

            // Проверяем на бред
            if (this._buffer.length >= AggroBot.SpamDetector.MESSAGES_TO_CHECK_ADVANCED) {
                const slice = this._buffer.slice(-AggroBot.SpamDetector.MESSAGES_TO_CHECK_ADVANCED);
                if (slice.every(request => request.type === AggroBot.Request.Type.TEXT) &&
                        !slice.some(request => AggroBot.SpamDetector.COMMON_MESSAGE_REG_EXP.test(request.text))) {
                    console.log("SPAM_REGULAR: ", JSON.stringify(slice));
                    return result = "spam_regular";
                }
            }

        })();

        // Проверяем на фото и стикеры
        if (!result && this._buffer.length >= AggroBot.SpamDetector.PHOTOS_CONSIDERED_SPAM &&
                this._buffer.slice(-AggroBot.SpamDetector.PHOTOS_CONSIDERED_SPAM).every(request =>
                    request.type === AggroBot.Request.Type.PHOTO)) result = "spam_photo";
        if (!result && this._buffer.length >= AggroBot.SpamDetector.STICKERS_CONSIDERED_SPAM &&
                this._buffer.slice(-AggroBot.SpamDetector.STICKERS_CONSIDERED_SPAM).every(request =>
                    request.type === AggroBot.Request.Type.STICKER)) result = "spam_sticker";

        if (!noStateChange) {
            if (result) switch (this.state) {
                case AggroBot.SpamDetector.State.ANALYZING:
                    this.state = AggroBot.SpamDetector.State.DETECTED_FIRST;
                    break;
                case AggroBot.SpamDetector.State.DETECTED_FIRST:
                    result = "spam_aggressive";
                    variables = {};
                    this.state = AggroBot.SpamDetector.State.DETECTED_SECOND;
                    break;
                case AggroBot.SpamDetector.State.DETECTED_SECOND:
                    result = "spam_ignoring";
                    variables = {};
                    this.state = AggroBot.SpamDetector.State.IGNORING;
                    break;
                case AggroBot.SpamDetector.State.IGNORING:
                    result = null;
                    break;
            }
            else {
                this._repeatedText = null;
                this.state = AggroBot.SpamDetector.State.ANALYZING;
            }
        }

        return {result, variables};
        
    }

    /**
     * Сохраняет ответ бота в буфере ответов (для проверки на копирование за ботом)
     * @param {string} response
     */
    storeOutput(response) {

        response = AggroBot.SpamDetector.cleanString(response);
        if (!response) return;
        this._outputBuffer.push(response);
        if (this._outputBuffer.length > AggroBot.SpamDetector.OUTPUT_BUFFER_SIZE) this._outputBuffer.shift();

    }
    
};

Object.assign(AggroBot.SpamDetector, {

    /**
     * Состояния анализатора
     * @enum
     * @readonly
     */
    State: Object.freeze({
        ANALYZING: 0,
        DETECTED_FIRST: 1,
        DETECTED_SECOND: 2,
        IGNORING: 3
    }),

    BUFFER_SIZE: 4,
    OUTPUT_BUFFER_SIZE: 12,
    MESSAGES_TO_CHECK_SIMPLE: 3,
    MESSAGES_TO_CHECK_ADVANCED: 4,
    STICKERS_CONSIDERED_SPAM: 2,
    PHOTOS_CONSIDERED_SPAM: 3,

    /**
     * Удаляет лишние символы из строки и, если строка есть повтор её подстроки, убирает повторы и оставляет эту подстроку
     * Иными словами, делает строку более подходящей для сравнения с другими строками
     * @param {string} str
     * @returns {string}
     */
    cleanString(str) {

        str = str.toLowerCase().replace(/[^а-яёa-z0-9 ]/g, "").trim();

        const longestPrefixSuffix = [0];
        let length = 0, i = 1;
        while (i < str.length) {
            if (str.charAt(i) == str.charAt(length)) longestPrefixSuffix[i++] = ++length;
            else if (length != 0) length = longestPrefixSuffix[length - 1];
            else longestPrefixSuffix[i++] = 0;
        }

        length = longestPrefixSuffix[str.length - 1];
        const prefixLength = str.length - length;
        if (length && str.length % prefixLength == 0) str = str.substr(0, prefixLength);

        return str;

    },

    /**
     * Расстояние Левенштейна
     * @param {string} str1
     * @param {string} str2
     * @returns {number}
     */
    levenshteinDistance(str1, str2) {

        if (!str1 || !str2) return (str1 || str2).length;

        const matrix = [];
        for (let i = 0; i <= str2.length; matrix[i] = [i++]);
        for (let j = 0; j <= str1.length; matrix[0][j] = j++);

        for (let i = 1; i <= str2.length; i++) for (let j = 1; j <= str1.length; j++) {
            matrix[i][j] = str2.charAt(i - 1) == str1.charAt(j - 1) ?
                matrix[i - 1][j - 1] :
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
        }

        return matrix[str2.length][str1.length];

    },

    /**
     * Проверяет, достаточно ли две строки похожи друг на друга, тобы можно было считать вторую полученной путём
     * копирования первой (или наоборот)
     * @param {string} str1
     * @param {string} str2
     * @returns {boolean}
     */
    stringsSimilar(str1, str2) {
        return AggroBot.SpamDetector.levenshteinDistance(str1, str2) / Math.min(str1.length, str2.length) < 0.15;
    },

    CHARACTER_NAMES: {
        "!": {singular: "воскл знак", plural: "воскл знаки", accusative: "воскл знак"},
        "\"": {singular: "кавычка", plural: "кавычки", accusative: "кавычку"},
        "#": {singular: "решетка", plural: "решетки", accusative: "решетку"},
        "$": {singular: "доллар", plural: "доллары", accusative: "доллар"},
        "%": {singular: "процент", plural: "проценты", accusative: "процент"},
        "&": {singular: "энд", plural: "энды", accusative: "энд"},
        "'": {singular: "кавычка", plural: "кавычки", accusative: "кавычку"},
        "(": {singular: "скобка", plural: "скобки", accusative: "скобку"},
        ")": {singular: "скобка", plural: "скобки", accusative: "скобку"},
        "*": {singular: "звездочка", plural: "звездочки", accusative: "звездочку"},
        "+": {singular: "плюс", plural: "плюсы", accusative: "плюс"},
        ",": {singular: "запятая", plural: "запятые", accusative: "запятую"},
        "-": {singular: "тире", plural: "тире", accusative: "тире"},
        ".": {singular: "точка", plural: "точки", accusative: "точку"},
        "/": {singular: "палочка", plural: "палочки", accusative: "палочку"},
        ":": {singular: "двоеточие", plural: "двоеточия", accusative: "двоеточие"},
        ";": {singular: "точка с запятой", plural: "точки с запятыми", accusative: "точку с запятой"},
        "<": {singular: "меньше", plural: "меньше", accusative: "меньше"},
        ">": {singular: "больше", plural: "больше", accusative: "больше"},
        "=": {singular: "равно", plural: "равно", accusative: "равно"},
        "?": {singular: "вопрос", plural: "вопросы", accusative: "вопрос"},
        "@": {singular: "собака", plural: "собаки", accusative: "собаку"},
        "[": {singular: "скобка", plural: "скобки", accusative: "скобку"},
        "]": {singular: "скобка", plural: "скобки", accusative: "скобку"},
        "\\": {singular: "палочка", plural: "палочки", accusative: "палочку"},
        "^": {singular: "крышечка", plural: "крышечки", accusative: "крышечку"},
        "_": {singular: "тире", plural: "тире", accusative: "тире"},
        "`": {singular: "кавычка", plural: "кавычки", accusative: "кавычку"},
        "{": {singular: "скобка", plural: "скобки", accusative: "скобку"},
        "|": {singular: "палочка", plural: "палочки", accusative: "палочку"},
        "}": {singular: "скобка", plural: "скобки", accusative: "скобку"},
        "~": {singular: "волна", plural: "волны", accusative: "волну"},
    },

    COMMON_WORDS: [
        "и", "в", "не", "на", "я", "был", "была", "он", "с", "что", "а", "по", "это", "она", "этот", "к", "но", "они",
        "мы", "как", "из", "у", "то", "за", "свой", "что", "весь", "год", "от", "так", "о", "для", "ты", "же", "все",
        "тот", "мочь", "вы", "человек", "такой", "его", "только", "или", "еще", "бы", "себя", "один", "как", "уже",
        "до", "время", "если", "сам", "когда", "вот", "наш", "мой", "при", "дело", "жизнь", "кто", "очень",
        "два", "день", "ее", "рука", "даже", "во", "со", "раз", "где", "там", "под", "можно", "ну", "после", "их",
        "без", "потом", "надо", "ли", "идти", "должен", "место", "ничто", "то", "сейчас",
        "тут", "лицо", "друг", "нет", "теперь", "ни", "да", "меня", "мне", "мной", "нас", "ее", "её", "м", "иди"
    ],

    COMMON_LETTER_COMBINATIONS: [
        "а ", "я ", "ой", "ска", "чка", "ай", "ть", "сто", "чик", "щик", "зна", "ста", "жи", "ный", "рый", "вый", "гов",
        "дый", "нна", "енн", "ян", "бы", "что", "име", "ша", "шка", "нка", "ние", "ия", "ого", "ому", "ами", "ыми",
        "ему", "ах", "ях", "вш", "ющ", "ущ", "ащ", "ящ", "ых", "ым", "при", "за", "из", "про", "пре", "анн", "ую",
        "инт", "тел", "ов", "ера", "ко", "во", "аз", "ад", "ал", "чо", "ле", "ет", "ут", "ют", "ат", "еб", "аб", "еш",
        "иц", "ец", "ца", "ци", "це", "оц", "цо", "ина", "шк", "тво", "сво", "мои", "мое", "теб", "тоб", "нам", "наш",
        "ваш", "ней", "нее", "ним", "иш", "ищ", "чь", "ий", "эй", "чит", "очи"
    ]
    
});

AggroBot.SpamDetector.COMMON_MESSAGE_REG_EXP = new RegExp(`([^а-яё]|^)(${AggroBot.SpamDetector.COMMON_WORDS.join("|")})([^а-яё]|$)|(${AggroBot.SpamDetector.COMMON_LETTER_COMBINATIONS.join("|")})`, "i");

VPP.Chat.prototype.aggrobot = function(command, ...args) {

    command = command.split(" ")[0];
    switch (command) {

        case "download":

            const $a = $("<a>").attr({
                href: VPPScript.meta["script-url"],
                download: VPPScript.meta["script-filename"]
            }).appendTo("body");
            $a[0].click();
            $a.remove();

            break;

        case "pause":

            if (this.aggroBot.active) this.aggroBot.suspend();
            break;

        case "resume":

            if (!this.aggroBot.active) {
                if (!this.aggrobotWasActive) this.aggroBot.reset();
                else this.aggroBot.resume();
            }
            break;

        default:

            if (!args.length) return;
            const keys = [command].concat(args.filter((_, index) => index & 1));
            const values = args.filter((_, index) => !(index & 1));
            if (keys.length > values.length) keys.pop();
            if (values.length > keys.length) values.pop();

            keys.forEach((key, index) => {
                if (!AggroBot.hasOwnProperty(key)) return;
                AggroBot[key] = (value => value == "true" ? true : value == "false" ? false : value)(values[index]);
                VPPScript.storage.set(key, AggroBot[key]);
            });
            VPPScript.storage.save();

    }

};

VPPScript.stop = () => {

    VPP.chats.forEach(chat => {
        if (chat.aggroBot) {
            chat.aggroBot.suspend();
            delete chat.aggroBot;
        }
        chat.removeEventListener("aggrobot");
    });
    delete VPP.Chat.prototype.aggrobot;

};
