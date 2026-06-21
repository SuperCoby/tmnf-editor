using GBX.NET;
using GBX.NET.LZO;
using GBX.NET.ZLib;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using TMNFeditor.Services;
using Blazored.LocalStorage;

Gbx.LZO = new Lzo();
Gbx.ZLib = new ZLib();

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<TMNFeditor.App>("#app");

builder.Services.AddScoped(sp => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });
builder.Services.AddBlazoredLocalStorage();
builder.Services.AddScoped<FileSystemService>();
builder.Services.AddSingleton<PakService>();

await builder.Build().RunAsync();
