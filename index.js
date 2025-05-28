require('dotenv').config()
const { App } = require('@slack/bolt');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
});

app.command('/onetimeview', async ({ command, ack, client }) => {
    await ack();
    const modal = JSON.parse(fs.readFileSync(path.join(__dirname, 'utils', 'modal.json'), 'utf8'));
    if (command.text) {
        const rec = await prisma.message.create({
            data: {
                user: command.user_id,
                message: command.text,
                expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            }
        })
        await client.chat.postMessage({
            channel: command.channel_id,
            text: `:viewonce: <@${command.user_id}> has sent a message which can only be viewed once. <https://time.cs50.io/${rec.expires.toISOString()}|It will expire in 1 week from now>.`,
            unfurl_media: false,
            unfurl_links: false,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `:viewonce: <@${command.user_id}> has sent a message which can only be viewed once. <https://time.cs50.io/${rec.expires.toISOString()}|It will expire in 1 week from now>.`,
                    },
                },
                {
                    type: "actions",
                    elements: [{
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: "👀 View",
                            emoji: true,
                        },
                        value: rec.id,
                        action_id: "view",
                    },
                    {
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: "📊 Stats",
                            emoji: true,
                        },
                        value: rec.id,
                        action_id: "stats",
                    },
                    {
                        type: "button",
                        style: "danger",
                        text: {
                            type: "plain_text",
                            text: "🗑️ Delete",
                            emoji: true,
                        },
                        value: rec.id,
                        action_id: "delete",
                    }],
                }
            ],
            icon_emoji: ":viewonce:",
        });
        return;
    }
    await client.views.open({
        trigger_id: command.trigger_id,
        view: { ...modal, private_metadata: JSON.stringify({ channel_id: command.channel_id }) },

    });
});

app.view('say_modal', async ({ ack, view, body, client, respond }) => {
    await ack();
    try {
        var json = JSON.parse(view.private_metadata)
    } catch (e) {
        await ack()
        return respond("Something bad happened. Likely more than one instance is running.")
    }
    const values = view.state.values;
    const channel = json.channel_id;


    const extracted = {};

    for (const blockId in values) {
        const actionObj = values[blockId];
        const [actionId, inputData] = Object.entries(actionObj)[0];

        if (inputData.type === 'rich_text_input' && inputData.rich_text_value) {
            const sections = inputData.rich_text_value.elements;
            extracted[actionId] = sections
                .map(section =>
                    section.elements.map(e => e.text).join('')
                ).join('');
        } else if (inputData.type === 'plain_text_input') {
            extracted[actionId] = inputData.value;
        }
        else if (inputData.type === 'datetimepicker') {
            extracted[actionId] = new Date(inputData.selected_date_time * 1000);
        }
    }

    const rec = await prisma.message.create({
        data: {
            user: body.user.id,
            message: extracted.text,
            image: extracted.image,
            expires: extracted.expires
        }
    })
    try {
        const user = (await app.client.users.info({
            user: body.user.id
        })).user
        const tz = user?.tz
        await client.chat.postMessage({
            channel: channel,
            text: `:viewonce: <@${body.user.id}> has sent a message which can only be viewed once. It will expire on ${extracted.expires.toLocaleString('en-US', { timeZone: tz, timeStyle: "short", dateStyle: "long" })} (${user.tz_label}, <https://time.cs50.io/${extracted.expires.toISOString()}|click to convert>)`,
            unfurl_media: false,
            unfurl_links: false,
            blocks: [
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `:viewonce: <@${body.user.id}> has sent a message which can only be viewed once. It will expire on ${extracted.expires.toLocaleString('en-US', { timeZone: tz, timeStyle: "short", dateStyle: "long" })} (${user.tz_label}, <https://time.cs50.io/${extracted.expires.toISOString()}|click to convert>)`,
                    },
                },
                {
                    type: "actions",
                    elements: [{
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: "👀 View",
                            emoji: true,
                        },
                        value: rec.id,
                        action_id: "view",
                    },
                    {
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: "📊 Stats",
                            emoji: true,
                        },
                        value: rec.id,
                        action_id: "stats",
                    },
                    {
                        type: "button",
                        style: "danger",
                        text: {
                            type: "plain_text",
                            text: "🗑️ Delete",
                            emoji: true,
                        },
                        value: rec.id,
                        action_id: "delete",
                    }],
                }
            ],
            icon_emoji: ":viewonce:",
        });
    } catch (error) {
        console.error("Failed to send message:", error);
    }
});
app.action("delete", async ({ ack, respond, say, body, payload }) => {
    await ack();
    const id = payload.value
    const rec = await prisma.message.findFirst({
        where: {
            id
        }
    })

    if (rec.user !== body.user.id) return await app.client.chat.postEphemeral({
        user: body.user.id,
        channel: body.channel.id,
        text: "Only the original poster can delete the message."
    })
    await app.client.chat.delete({
        channel: body.channel.id,
        ts: body.message.ts
    })
    await prisma.message.delete({
        where: {
            id
        }
    })
    await app.client.chat.postEphemeral({
        user: body.user.id,
        channel: body.channel.id,
        text: "Poof."
    })
});
app.action("stats", async ({ ack, respond, say, body, payload }) => {
    await ack();
    const id = payload.value
    const rec = await prisma.message.findFirst({
        where: {
            id
        }
    })
    const user = (await app.client.users.info({
        user: body.user.id
    })).user
    const tz = user?.tz
    if (rec.user !== body.user.id) return await app.client.chat.postEphemeral({
        user: body.user.id,
        channel: body.channel.id,
        text: "Only the original poster can view stats."
    })
    var views = await prisma.view.findMany({
        where: {
            messageId: id
        }
    })
    views = views.map(view => `- <@${view.user}> on ${view.createdAt.toLocaleString('en-US', { timeZone: tz, timeStyle: "short", dateStyle: "long" })}`)
    await app.client.chat.postEphemeral({
        user: body.user.id,
        channel: body.channel.id,
        text: views.length !== 0 ? views.join("\n") + `\n\n(times and dates are in \`${user?.tz_label}\`)` : `No views yet.`
    })
});
app.action("view", async ({ ack, respond, say, body, payload }) => {
    await ack();
    const id = payload.value
    const rec = await prisma.message.findFirst({
        where: {
            id
        }
    })
    if (rec.expires < new Date()) return await app.client.chat.postEphemeral({
        user: body.user.id,
        channel: body.channel.id,
        text: "This view-once message has expired already."
    })
    const modal = {
        "type": "modal",
        "title": {
            "type": "plain_text",
            "text": "One Time View",
            "emoji": true
        },
        "close": {
            "type": "plain_text",
            "text": "Close",
            "emoji": true
        },
        "blocks": [
        ]
    }
    if (rec.message) modal.blocks.push({
        "type": "section",
        "text": {
            "type": "mrkdwn",
            "text": rec.message
        }
    })
    if (rec.image) modal.blocks.push({
        "type": "image",
        "image_url": rec.image,
        "alt_text": "delicious image"
    })
    if (rec.user == body.user.id) return await app.client.views.open({
        trigger_id: body.trigger_id,
        callback_id: "useless_modal",
        view: modal
    });

    const view = await prisma.view.findFirst({
        where: {
            user: body.user.id,
            messageId: id
        }
    })
    if (!view) {
        await prisma.view.create({
            data: {
                user: body.user.id,
                messageId: id
            }
        })
        return await app.client.views.open({
            trigger_id: body.trigger_id,
            callback_id: "useless_modal",
            view: modal
        });

    } else {
        await app.client.chat.postEphemeral({
            user: body.user.id,
            channel: body.channel.id,
            text: "You've already seen this media."
        })
    }
});

(async () => {
    await app.start();
    console.log('OTV is running!');

})();

process.on("unhandledRejection", (error) => {
    console.error(error);
});