# Redis-Sentinel (js)
### Redis Sentinel Client for Node.js

Redis-Sentinel is a wrapper for the node redis client designed for use with
a redis sentinel cluster.  The Sentinel Monitor subscribes to Sentinel Pub/Sub
and maintains the state of redis server clusters.  A single client abstraction
is provided to access all instances in a given named cluster.  If the master 
instance of a cluster fails, the Master Client enters a fallback state,
queuing write commands and executing read commands on the first available
slave and untill a new master has been elected by the sentinels.  

## Create a Sentinel Monitor

    require('redis-sentinel-js');
    var sentinel_monitor = new Monitor(options);
    sentinel_monitor.once('sync', function do_stuff(){...});
    sentinel_monitor.sync();

### options

options.sentinels* => ['localhost:26379', '127.0.0.1:26380', ...]
The addresses to the sentinels in this cluster

options.timeout  => 5000
The timeout for write requests waiting for execution during failsafe state

*required

## Get a Master Client

    var mc = sentinel_monitor.get_client('mymaster');
    mc.set('x', 5, function(error, response){...} );

Master clients extend the node redis client.
