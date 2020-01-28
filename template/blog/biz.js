var trackersJSON = '{trackersJSON}';
var sourceNewsJSON = '{sourceNewsJSON}';
var initialTorrentId = '{initialTorrentId}';
var syncnews = '{syncnews}';
var sourceNews = {};
function getTrackersString() {
    var trackerUrls = JSON.parse(trackersJSON);
    var trackersString = "";
    for (var i = 0; i < trackerUrls.length; i++) {
        var url = getString(trackerUrls[i]);
        trackersString += "&tr=" + encodeURIComponent(url);
    }
    return trackersString;
}
function getMagnetLink(id, defaultId) {
    var ele = sourceNews[id];
    var fname = getString(ele.pureName);
    if (ele && ele.fileName) {
        return "magnet:?xt=urn:btih:" + id + (fname ? encodeURIComponent(fname) : encodeURIComponent(ele.fileName)) + getTrackersString();
    } else {
        //bug to fix
        return "magnet:?xt=urn:btih:" + defaultId + (fname ? encodeURIComponent(fname) : encodeURIComponent(ele.fileName)) + getTrackersString();
    }
}
function getTorrentIdFromMagnetLink(link) {
    if (link) {
        var a1 = link.split('&');
        if (a1.length > 0) {
            var a2 = a1[0].split('btih:');
            if (a2.length > 1) {
                return a2[1];
            }
        }
    }
}

function getString(str) {
    try {
        return OtpJS.AES.decrypt(str, oskf).toString(OtpJS.enc.Utf8);
    } catch (err) {
        return str;
    }
}

function getParameterByName(name, url) {
    var val;
    if (!url) url = window.location.href;
    // name = name.replace(/[\[\]]/g, '\\$&');
    var regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)'),
        results = regex.exec(url);
    if (results && results[2]) {
        val = decodeURIComponent(results[2].replace(/\+/g, ' '));
    }
    if (!val) val = initialTorrentId;
    return val;
}

$(function() {
    $("#truth-titles").html("<a href='#'>這是一個真相標題</a>");
    $.getJSON(getString(syncnews), function(data) {
        var items = [];
        sourceNews = {};
        $.each(data.reverse(), function(key, val) {
            var pureName = val.fileName.substr(0, val.fileName.lastIndexOf('.')) || val.fileName;
            items.push("<li><a href='?id=" + val.id + "'>" + pureName + "</a></li>");
            sourceNews[val.id] = {
                fileName: val.fileName,
                pureName: pureName,
            };
        });
        $("#news-titles").html(items.join(""));
        var playTorrentId = getParameterByName("id");
        $("#content-title").text(sourceNews[playTorrentId].pureName);
        setup(playTorrentId);
    }).fail(function() {
        var items = [];
        sourceNews = JSON.parse(sourceNewsJSON);
        var sourceNewsKeys = Object.keys(sourceNews).reverse();
        for (var i = 0; i < sourceNewsKeys.length; i++) {
            var key = sourceNewsKeys[i];
            var ele = sourceNews[key];
            if (ele) {
                var pname = getString(ele.pureName);
                items.push("<li><a href='?id=" + key + "'>" + pname + "</a></li>");
            }
        }
        $("#news-titles").html(items.join(""));
        var playTorrentId = getParameterByName("id");
        $("#content-title").text(getString(sourceNews[playTorrentId].pureName));
        setup(playTorrentId);
    });
});

var client = new WebTorrent()

// HTML elements
var $body = document.body
var $progressBar = document.querySelector('#progressBar')
var $loading = document.querySelector('#loading');
var $numPeers = document.querySelector('#numPeers')
var $downloaded = document.querySelector('#downloaded')
var $total = document.querySelector('#total')
var $remaining = document.querySelector('#remaining')
var $uploadSpeed = document.querySelector('#uploadSpeed')
var $downloadSpeed = document.querySelector('#downloadSpeed')

function setup(playTorrentId) {
    var torrentLink = getMagnetLink(playTorrentId);
    // console.log(torrentLink);
    // Download the torrent
    client.add(torrentLink, function(torrent) {

        // Torrents can contain many files. Let's use the .mp4 file
        var file = torrent.files.find(function(file) {
            return file.name.endsWith('.mp4')
        });

        // Stream the file in the browser
        file.appendTo('#output');

        // Trigger statistics refresh
        torrent.on('done', onDone);
        setInterval(onProgress, 500);
        onProgress();

        // Statistics
        function onProgress() {
            // Peers
            $loading.innerHTML = "请点击播放键开始观看"
            $numPeers.innerHTML = torrent.numPeers + (torrent.numPeers === 1 ? ' peer' : ' peers')

            // Progress
            var percent = Math.round(torrent.progress * 100 * 100) / 100;
            $progressBar.style.width = percent + '%';
            $downloaded.innerHTML = prettyBytes(torrent.downloaded);
            $total.innerHTML = prettyBytes(torrent.length);

            // Remaining time
            var remaining;
            if (torrent.done) {
            remaining = 'Done.'
            } else {
            var number = Math.round(torrent.timeRemaining / 1000 / 60 * 10) / 10;
            remaining = number + ' minutes left.'
            }
            $remaining.innerHTML = remaining;

            // Speed rates
            $downloadSpeed.innerHTML = prettyBytes(torrent.downloadSpeed) + '/s';
            $uploadSpeed.innerHTML = prettyBytes(torrent.uploadSpeed) + '/s';
        }

        function onDone() {
            $body.className += ' is-seed';
            onProgress();
        }
    });
}

// Human readable bytes util
function prettyBytes(num) {
    var exponent, unit, neg = num < 0,
        units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
    if (neg) num = -num
    if (num < 1) return (neg ? '-' : '') + num + ' B'
    exponent = Math.min(Math.floor(Math.log(num) / Math.log(1000)), units.length - 1)
    num = Number((num / Math.pow(1000, exponent)).toFixed(2))
    unit = units[exponent]
    return (neg ? '-' : '') + num + ' ' + unit
}