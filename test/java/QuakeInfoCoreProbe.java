package net.teamfruit.eewbot.quakeinfo;

import com.google.gson.*;
import net.teamfruit.eewbot.Codecs;
import net.teamfruit.eewbot.QuakeInfoStore;
import net.teamfruit.eewbot.entity.EmbedContext;
import net.teamfruit.eewbot.entity.jma.QuakeInfo;
import net.teamfruit.eewbot.entity.jma.telegram.VXSE53Impl;
import net.teamfruit.eewbot.entity.renderer.RendererQueryFactory;
import net.teamfruit.eewbot.i18n.I18n;
import net.teamfruit.eewbot.registry.config.ConfigV2;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;

/** Test-only driver: actual Core XML parser, renderer, client and asynchronous publisher. */
public final class QuakeInfoCoreProbe {
    private static RemoteQuakeInfoSnapshotClient client(ConfigV2.QuakeInfoPublisher config) {
        return new RemoteQuakeInfoSnapshotClient(config, "synthetic-core-id", "synthetic-core-secret", true);
    }

    private static QuakeInfo report(String fixture, String variant, Instant reportTime) throws Exception {
        if (reportTime.isAfter(Instant.parse("2001-01-01T00:00:00Z"))) throw new IllegalArgumentException("Test dates must stay historical");
        String info = variant.equals("cancel") ? "取消" : variant.equals("correction") ? "訂正" : "発表";
        String time = (variant.equals("older") ? reportTime.minusSeconds(1) : reportTime).toString();
        String xml = fixture.replaceAll("<InfoType>.*?</InfoType>", "<InfoType>" + info + "</InfoType>")
                .replaceAll("<Serial>.*?</Serial>", "<Serial>1</Serial>")
                .replaceAll("<EventID>.*?</EventID>", "<EventID>TEST-quakeinfo-fixture</EventID>")
                .replaceAll("<ReportDateTime>.*?</ReportDateTime>", "<ReportDateTime>" + time + "</ReportDateTime>")
                .replaceAll("<DateTime>.*?</DateTime>", "<DateTime>" + time + "</DateTime>")
                .replaceAll("<PublishingOffice>.*?</PublishingOffice>", "<PublishingOffice>TEST DATA - NOT A REAL EARTHQUAKE</PublishingOffice>")
                .replaceAll("(?s)<FreeFormComment>.*?</FreeFormComment>", "");
        // Force real EmbedPacker pagination from a parsed XML comment.
        xml = xml.replace("</Comments>", "<FreeFormComment>TEST DATA - NOT A REAL EARTHQUAKE\n" + "TEST fixture text\n".repeat(650) + "</FreeFormComment></Comments>");
        return Codecs.XML_MAPPER.readValue(xml, VXSE53Impl.class);
    }

    public static void main(String[] args) throws Exception {
        var settings = new JsonObject();
        settings.addProperty("baseUrl", args[0]);
        settings.addProperty("reconcileIntervalMillis", 100);
        var config = Codecs.GSON.fromJson(settings, ConfigV2.QuakeInfoPublisher.class);
        var store = new QuakeInfoStore();
        var context = new EmbedContext(new RendererQueryFactory("https://renderer.example.test", "synthetic-renderer-key"), store, new I18n("ja_jp"));
        String fixture = Files.readString(Path.of(args[1]));
        QuakeInfoSnapshotPublisher publisher = null;
        try (var client = client(config);
             var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            System.out.println("READY");
            for (String line; (line = input.readLine()) != null; ) {
                var command = JsonParser.parseString(line).getAsJsonObject();
                String action = command.get("action").getAsString();
                String variant = command.has("variant") ? command.get("variant").getAsString() : "normal";
                Instant reportTime = command.has("reportDateTime") ? Instant.parse(command.get("reportDateTime").getAsString())
                        : Instant.parse("2000-01-01T00:00:00Z");
                var result = new JsonObject();
                if (action.equals("publish")) {
                    var parsed = report(fixture, variant, reportTime);
                    store.putReport(parsed);
                    var selected = variant.equals("older") ? parsed : store.getLatestReport().orElseThrow();
                    var snapshot = QuakeInfoSnapshot.render((QuakeInfo) selected, context);
                    var published = client.publish(snapshot);
                    result.addProperty("accepted", published.accepted());
                    result.addProperty("revision", published.revision());
                    result.add("body", JsonParser.parseString(snapshot.body()));
                } else if (action.equals("store")) {
                    store.putReport(report(fixture, variant, reportTime));
                    result.addProperty("stored", true);
                } else if (action.equals("start-publisher")) {
                    publisher = new QuakeInfoSnapshotPublisher(store, context, client(config), config);
                    publisher.start();
                    result.addProperty("started", true);
                } else if (action.equals("stop-publisher")) {
                    if (publisher != null) publisher.close();
                    result.addProperty("stopped", true);
                } else throw new IllegalArgumentException("Unknown test action");
                System.out.println("RESULT " + Codecs.GSON.toJson(result));
                System.out.flush();
            }
        } finally {
            if (publisher != null) publisher.close();
        }
    }
}
