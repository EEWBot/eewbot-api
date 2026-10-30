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
import java.util.UUID;

/** Test-only driver: actual Core XML parser, renderer, client and asynchronous publisher. */
public final class QuakeInfoCoreProbe {
    public static void main(String[] args) throws Exception {
        var settings = new JsonObject();
        settings.addProperty("baseUrl",args[0]);
        settings.addProperty("reconcileIntervalMillis",100);
        var config = Codecs.GSON.fromJson(settings,ConfigV2.QuakeInfoPublisher.class);
        var store = new QuakeInfoStore();
        var context = new EmbedContext(new RendererQueryFactory("https://renderer.example.test","synthetic-renderer-key"),store,new I18n("ja_jp"));
        String fixture = Files.readString(Path.of(args[1]));
        QuakeInfoSnapshotPublisher publisher = null;
        QuakeInfoSnapshot pending = null;
        long sequence = 0;
        try (var client = new RemoteQuakeInfoSnapshotClient(config,"synthetic-core-id","synthetic-core-secret",true);
             var input = new BufferedReader(new InputStreamReader(System.in,StandardCharsets.UTF_8))) {
            long epoch = client.lease(UUID.randomUUID().toString());
            System.out.println("READY");
            for (String line; (line = input.readLine()) != null;) {
                var command = JsonParser.parseString(line).getAsJsonObject();
                String action = command.get("action").getAsString();
                var result = new JsonObject();
                if (action.equals("stage")) {
                    String variant = command.get("variant").getAsString();
                    String info = variant.equals("cancel") ? "取消" : variant.equals("correction") ? "訂正" : "発表";
                    String time = variant.equals("older") ? "1999-01-01T00:00:00Z" : "2000-01-01T00:00:00Z";
                    String xml = fixture.replaceAll("<InfoType>.*?</InfoType>","<InfoType>" + info + "</InfoType>")
                            .replaceAll("<Serial>.*?</Serial>","<Serial>1</Serial>")
                            .replaceAll("<EventID>.*?</EventID>","<EventID>TEST-quakeinfo-fixture</EventID>")
                            .replaceAll("<ReportDateTime>.*?</ReportDateTime>","<ReportDateTime>" + time + "</ReportDateTime>")
                            .replaceAll("<DateTime>.*?</DateTime>","<DateTime>" + time + "</DateTime>")
                            .replaceAll("<PublishingOffice>.*?</PublishingOffice>","<PublishingOffice>TEST DATA - NOT A REAL EARTHQUAKE</PublishingOffice>")
                            .replaceAll("(?s)<FreeFormComment>.*?</FreeFormComment>","");
                    // Force real EmbedPacker pagination from a parsed XML comment.
                    xml = xml.replace("</Comments>","<FreeFormComment>TEST DATA - NOT A REAL EARTHQUAKE\n" + "TEST fixture text\n".repeat(650) + "</FreeFormComment></Comments>");
                    var report = Codecs.XML_MAPPER.readValue(xml,VXSE53Impl.class);
                    store.putReport(report);
                    var selected = variant.equals("older") ? report : store.getLatestReport().orElseThrow();
                    pending = QuakeInfoSnapshot.render((QuakeInfo) selected,context,epoch,++sequence);
                    client.create(pending);
                    for (var language : pending.messages().entrySet()) for (int i = 0; i < language.getValue().size(); i++)
                        client.put(pending.snapshotId(),language.getKey(),i,language.getValue().get(i));
                    result.addProperty("snapshotId",pending.snapshotId());
                    result.add("messages",Codecs.GSON.toJsonTree(pending.messages()));
                    result.add("metadata",JsonParser.parseString(pending.metadataJson()));
                } else if (action.equals("commit")) {
                    try { client.commit(pending.snapshotId()); result.addProperty("committed",true); }
                    catch (QuakeInfoSnapshotClient.Failure e) { result.addProperty("status",e.status()); }
                } else if (action.equals("start-publisher")) {
                    publisher = new QuakeInfoSnapshotPublisher(store,context,
                            new RemoteQuakeInfoSnapshotClient(config,"synthetic-core-id","synthetic-core-secret",true),config);
                    publisher.start();
                    long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
                    while (client.latest().publisherEpoch() <= epoch && System.nanoTime() < deadline) Thread.sleep(20);
                    if (client.latest().publisherEpoch() <= epoch) throw new IllegalStateException("Publisher did not converge");
                    result.addProperty("publisherEpoch",client.latest().publisherEpoch());
                } else if (action.equals("stop-publisher")) {
                    if (publisher != null) publisher.close();
                    result.addProperty("stopped",true);
                } else throw new IllegalArgumentException("Unknown test action");
                System.out.println("RESULT " + Codecs.GSON.toJson(result));
                System.out.flush();
            }
        } finally { if (publisher != null) publisher.close(); }
    }
}
