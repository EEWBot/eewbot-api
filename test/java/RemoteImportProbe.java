package net.teamfruit.eewbot.registry.destination.remote;

/** Runs Core's real legacy import CLI against the loopback Worker, with test-only credentials. */
public final class RemoteImportProbe {
    public static void main(String[] args) {
        int code = RemoteDestinationImport.run(args, name -> switch (name) {
            case "EEWBOT_CF_ACCESS_CLIENT_ID" -> "synthetic-core-id";
            case "EEWBOT_CF_ACCESS_CLIENT_SECRET" -> "synthetic-core-secret";
            default -> null;
        }, true);
        System.out.println("EXIT " + code);
    }
}
