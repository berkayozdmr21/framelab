FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY src/ src/
RUN dotnet publish src/FrameLab.Api -c Release -o /out/api && dotnet publish src/FrameLab.Worker -c Release -o /out/worker
FROM mcr.microsoft.com/dotnet/aspnet:10.0
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && apt-get clean
WORKDIR /app
COPY --from=build /out/ /app/
ENV DataPath=/data MediaPath=/data/media ASPNETCORE_URLS=http://+:8080 FontPath=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
RUN mkdir /data && chown -R $APP_UID /data /app
USER $APP_UID
ENTRYPOINT ["dotnet", "api/FrameLab.Api.dll"]
