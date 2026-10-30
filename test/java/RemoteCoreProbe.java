package net.teamfruit.eewbot.registry.destination.remote;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.teamfruit.eewbot.registry.config.ConfigV2;
import net.teamfruit.eewbot.i18n.I18n;
import net.teamfruit.eewbot.registry.destination.delivery.DeliverySnapshot;
import net.teamfruit.eewbot.registry.destination.delivery.RevisionPoller;
import net.teamfruit.eewbot.registry.destination.delivery.SnapshotDeliveryRegistry;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.concurrent.Executors;

/** Uses real Core sources, its explicit test-only loopback allowance, and no Gateway. */
public final class RemoteCoreProbe {
    public static void main(String[] args) throws Exception {
        ConfigV2.Remote config = new Gson().fromJson("{\"baseUrl\":\"" + args[0]
                + "\",\"pollIntervalMillis\":20}", ConfigV2.Remote.class);
        var reload = Executors.newSingleThreadExecutor();
        var scheduler = Executors.newSingleThreadScheduledExecutor();
        try (var client = new RemoteConfigApiClient(config, "synthetic-core-id", "synthetic-core-secret", true)) {
            var source = new RemoteDestinationConfigSource(client);
            var i18n = new I18n("ja_jp");
            var registry = new SnapshotDeliveryRegistry(source, reload);
            registry.initializeSnapshot();
            var poller = new RevisionPoller(registry, source, scheduler, 20, true);
            poller.start();
            try {
                System.out.println("READY");
                var input = new BufferedReader(new InputStreamReader(System.in));
                for (String line; (line = input.readLine()) != null;) {
                    JsonObject expected = JsonParser.parseString(line).getAsJsonObject();
                    long revision = expected.get("revision").getAsLong();
                    long deadline = System.nanoTime() + 5_000_000_000L;
                    while (registry.getSnapshot().getRevision() < revision && System.nanoTime() < deadline) Thread.sleep(10);
                    assertSnapshot(registry.getSnapshot(), expected, i18n);
                    System.out.println("OK " + expected.get("stage").getAsString() + " revision=" + revision);
                }
            } finally { poller.stop(); }
        } finally {
            scheduler.shutdownNow();
            reload.shutdownNow();
        }
    }

    /** API v2 sends {id, token}; Core must rebuild the execute URL, including thread_id. */
    private static boolean webhookMatches(net.teamfruit.eewbot.registry.destination.model.ChannelWebhook actual, JsonObject d) {
        if (d.get("webhook").isJsonNull()) return actual == null;
        if (actual == null) return false;
        var webhook = d.getAsJsonObject("webhook");
        String id = webhook.get("id").getAsString();
        String token = webhook.get("token").getAsString();
        String url = "https://discord.com/api/webhooks/" + id + "/" + token
                + (d.get("threadId").isJsonNull() ? "" : "?thread_id=" + d.get("threadId").getAsString());
        return actual.id() == Long.parseLong(id) && actual.token().equals(token) && actual.url().equals(url);
    }

    private static void assertSnapshot(DeliverySnapshot snapshot, JsonObject expected, I18n i18n) {
        if (snapshot.getRevision() != expected.get("revision").getAsLong()
                || snapshot.size() != expected.getAsJsonArray("destinations").size()) throw new AssertionError("Snapshot did not converge");
        for (var item : expected.getAsJsonArray("destinations")) {
            var d = item.getAsJsonObject();
            var actual = snapshot.get(d.get("targetId").getAsLong());
            if (actual == null || actual.channelId() != d.get("channelId").getAsLong()
                    || !java.util.Objects.equals(actual.threadId(), d.get("threadId").isJsonNull() ? null : d.get("threadId").getAsLong())
                    || !java.util.Objects.equals(actual.guildId(), d.get("guildId").isJsonNull() ? null : d.get("guildId").getAsLong())
                    || actual.eewAlert() != d.get("eewAlert").getAsBoolean()
                    || actual.eewPrediction() != d.get("eewPrediction").getAsBoolean()
                    || actual.eewDecimation() != d.get("eewDecimation").getAsBoolean()
                    || actual.quakeInfo() != d.get("quakeInfo").getAsBoolean()
                    || actual.tsunami() != d.get("tsunami").getAsBoolean()
                    || actual.minIntensity().getCode() != d.get("minIntensity").getAsInt()
                    || !actual.lang().equals(d.get("lang").getAsString())
                    || !webhookMatches(actual.webhook(), d)) {
                throw new AssertionError("Core snapshot fields differ from committed D1 state");
            }
            if (i18n.getLanguages().containsKey(actual.lang())) {
                String key = "eewbot.scmd.lang.set.followup";
                String translated = i18n.format(actual.lang(), key, i18n.getLanguages().get(actual.lang()));
                if (translated.equals(key) || translated.isBlank()) throw new AssertionError("Core language resource did not resolve");
            }
        }
    }
}
